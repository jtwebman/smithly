import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname as pathDirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawn, type IPty } from "node-pty";

import type { ChatMessageRole } from "@smithly/core";
import type { IStorageContext } from "@smithly/storage";

export interface IBootstrapOutputEntry {
  readonly id: string;
  readonly role: ChatMessageRole;
  readonly bodyText: string;
  readonly createdAt: string;
}

export interface IBootstrapOutputEvent {
  readonly terminalKey: string;
  readonly rawData: string;
  readonly entries: readonly IBootstrapOutputEntry[];
}

export interface IBootstrapSessionSnapshot {
  readonly cwd: string;
  readonly messages: readonly IBootstrapOutputEntry[];
  readonly status: "starting" | "running" | "waiting" | "exited" | "failed";
  readonly terminalKey: string;
}

interface IBootstrapRuntimeSession {
  readonly createdAt: string;
  readonly cwd: string;
  lineBuffer: string;
  readonly logFilePath: string;
  readonly pty: IPty;
  readonly terminalKey: string;
}

interface IBootstrapSessionManagerOptions {
  readonly now?: () => Date;
  readonly spawnPty?: typeof spawn;
}

interface IMcpServerConfig {
  readonly mcpServers: {
    readonly smithly: {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Record<string, string>;
    };
  };
}

const BOOTSTRAP_TERMINAL_KEY = "planning:bootstrap";

export class BootstrapSessionManager {
  private session: IBootstrapRuntimeSession | null = null;
  private snapshot: IBootstrapSessionSnapshot | null = null;
  private readonly now: () => Date;
  private readonly spawnPty: typeof spawn;

  public constructor(
    private readonly context: IStorageContext,
    private readonly emitOutput: (event: IBootstrapOutputEvent) => void,
    private readonly onUpdated: () => void,
    options: IBootstrapSessionManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.spawnPty = options.spawnPty ?? spawn;
  }

  public ensureSession(): void {
    if (this.session !== null) {
      return;
    }

    const startedAt = this.now().toISOString();
    const cwd = homedir();
    const logFilePath = join(
      this.context.config.storage.dataDirectory,
      "worker-logs",
      `bootstrap-${randomUUID()}.log`,
    );

    this.snapshot = {
      cwd,
      messages: [],
      status: "starting",
      terminalKey: BOOTSTRAP_TERMINAL_KEY,
    };
    this.appendSessionLog(
      logFilePath,
      `[smithly] bootstrap session started in ${cwd} at ${startedAt}\n`,
    );
    this.onUpdated();

    try {
      const mcpConfig = this.buildMcpServerConfig();
      const pty = this.spawnPty(
        this.context.config.workers.claude.command,
        this.buildWorkerArgs(this.context.config.workers.claude.command, mcpConfig),
        {
          cols: 120,
          cwd,
          env: {
            ...process.env,
            SMITHLY_BOOTSTRAP_SESSION: "1",
            SMITHLY_MCP_CONFIG_JSON: JSON.stringify(mcpConfig),
          },
          name: "xterm-256color",
          rows: 32,
        },
      );

      this.session = {
        createdAt: startedAt,
        cwd,
        lineBuffer: "",
        logFilePath,
        pty,
        terminalKey: BOOTSTRAP_TERMINAL_KEY,
      };
      this.snapshot = {
        cwd,
        messages: [],
        status: "running",
        terminalKey: BOOTSTRAP_TERMINAL_KEY,
      };
      this.onUpdated();

      pty.onData((rawData) => {
        if (this.session === null || this.snapshot === null) {
          return;
        }

        this.appendSessionLog(this.session.logFilePath, rawData);
        const entries = this.persistOutput(rawData);
        this.emitOutput({
          entries,
          rawData,
          terminalKey: BOOTSTRAP_TERMINAL_KEY,
        });
      });

      pty.onExit(({ exitCode }) => {
        if (this.snapshot === null) {
          return;
        }

        const status = exitCode === 0 ? "exited" : "failed";
        const message = `[smithly] Claude bootstrap session ${status} (${exitCode}).`;

        this.appendSessionLog(logFilePath, `${message}\n`);
        const entries = this.persistStaticMessages([message], "system");

        this.snapshot = {
          ...this.snapshot,
          messages: [...this.snapshot.messages, ...entries].slice(-200),
          status,
        };
        this.session = null;
        this.emitOutput({
          entries,
          rawData: `\r\n${message}\r\n`,
          terminalKey: BOOTSTRAP_TERMINAL_KEY,
        });
        this.onUpdated();
      });
    } catch (error: unknown) {
      const failureMessage = `[smithly] Unable to start Claude bootstrap session: ${error instanceof Error ? error.message : String(error)}.`;
      const entries = this.persistStaticMessages([failureMessage], "system");

      this.snapshot = {
        cwd,
        messages: entries,
        status: "failed",
        terminalKey: BOOTSTRAP_TERMINAL_KEY,
      };
      this.appendSessionLog(logFilePath, `${failureMessage}\n`);
      this.emitOutput({
        entries,
        rawData: `${failureMessage}\r\n`,
        terminalKey: BOOTSTRAP_TERMINAL_KEY,
      });
      this.onUpdated();
    }
  }

  public writeToSession(terminalKey: string, data: string): boolean {
    if (data.length === 0 || terminalKey !== BOOTSTRAP_TERMINAL_KEY || this.session === null) {
      return false;
    }

    this.session.pty.write(data);
    return true;
  }

  public resizeSession(terminalKey: string, cols: number, rows: number): boolean {
    if (cols <= 0 || rows <= 0 || terminalKey !== BOOTSTRAP_TERMINAL_KEY || this.session === null) {
      return false;
    }

    this.session.pty.resize(cols, rows);
    return true;
  }

  public getSnapshot(): IBootstrapSessionSnapshot | undefined {
    return this.snapshot === null ? undefined : { ...this.snapshot };
  }

  public dispose(): void {
    this.session?.pty.kill();
    this.session = null;
  }

  private buildMcpServerConfig(): IMcpServerConfig {
    return {
      mcpServers: {
        smithly: {
          args: [resolveMcpBridgePath()],
          command: process.env.SMITHLY_NODE_COMMAND?.trim() || "node",
          env: {
            SMITHLY_ATTACH_SCOPE: "global",
            SMITHLY_DATA_DIRECTORY: this.context.config.storage.dataDirectory,
          },
        },
      },
    };
  }

  private buildWorkerArgs(command: string, mcpConfig: IMcpServerConfig): string[] {
    const configuredArgs = [...this.context.config.workers.claude.args];

    if (basename(command) !== "claude") {
      return configuredArgs;
    }

    return [...configuredArgs, "--mcp-config", JSON.stringify(mcpConfig), "--strict-mcp-config"];
  }

  private persistOutput(rawData: string): IBootstrapOutputEntry[] {
    if (this.session === null || this.snapshot === null) {
      return [];
    }

    const sanitizedData = stripAnsi(rawData).replaceAll("\r\n", "\n").replaceAll("\r", "\n");

    this.session.lineBuffer += sanitizedData;
    const completeLines = this.session.lineBuffer.split("\n");

    this.session.lineBuffer = completeLines.pop() ?? "";

    const entries = this.persistStaticMessages(completeLines, "claude");

    this.snapshot = {
      ...this.snapshot,
      messages: [...this.snapshot.messages, ...entries].slice(-200),
      status: "running",
    };
    this.onUpdated();

    return entries;
  }

  private persistStaticMessages(
    lines: readonly string[],
    role: ChatMessageRole,
  ): IBootstrapOutputEntry[] {
    return lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((bodyText) => {
        return {
          bodyText,
          createdAt: this.now().toISOString(),
          id: `bootstrap-message-${randomUUID()}`,
          role,
        };
      });
  }

  private appendSessionLog(logFilePath: string, content: string): void {
    mkdirSync(pathDirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, content);
  }
}

function stripAnsi(value: string): string {
  let output = "";
  let index = 0;

  while (index < value.length) {
    if (value.charCodeAt(index) !== 27) {
      output += value[index];
      index += 1;
      continue;
    }

    index += 1;

    if (value[index] !== "[") {
      continue;
    }

    index += 1;

    while (index < value.length) {
      const characterCode = value.charCodeAt(index);

      index += 1;

      if (characterCode >= 64 && characterCode <= 126) {
        break;
      }
    }
  }

  return output;
}

function resolveMcpBridgePath(): string {
  return join(dirname(), "../../../packages/mcp-server/src/bridge-main.js");
}

function dirname(): string {
  return pathDirname(fileURLToPath(import.meta.url));
}

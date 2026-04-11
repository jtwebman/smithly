import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname as pathDirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawn, type IPty } from "node-pty";

import type {
  ChatMessageRole,
  IChatMessageRecord,
  IChatThreadRecord,
  IMemoryNoteRecord,
  IWorkerSessionRecord,
} from "@smithly/core";
import {
  getBacklogItemById,
  getProjectById,
  listChatMessagesForThread,
  listChatThreadsForProject,
  upsertChatMessage,
  upsertChatThread,
  upsertMemoryNote,
  upsertWorkerSession,
  type IStorageContext,
} from "@smithly/storage";

export type PlanningScope = "project" | "task";

export interface IPlanningOutputEntry {
  readonly id: string;
  readonly role: ChatMessageRole;
  readonly bodyText: string;
  readonly createdAt: string;
}

export interface IPlanningOutputEvent {
  readonly terminalKey: string;
  readonly rawData: string;
  readonly entries: readonly IPlanningOutputEntry[];
}

export interface IEnsurePlanningSessionInput {
  readonly scope: PlanningScope;
  readonly projectId: string;
  readonly backlogItemId?: string;
}

interface IPlanningRuntimeSession {
  readonly backlogItemId?: string;
  readonly createdAt: string;
  readonly logFilePath: string;
  readonly projectId: string;
  readonly pty: IPty;
  readonly scope: PlanningScope;
  readonly startedAt: string;
  readonly terminalKey: string;
  readonly threadId: string;
  readonly workerSessionId: string;
  lineBuffer: string;
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

interface IPlanningSessionManagerOptions {
  readonly now?: () => Date;
  readonly spawnPty?: typeof spawn;
}

export class PlanningSessionManager {
  private readonly sessions = new Map<string, IPlanningRuntimeSession>();
  private readonly now: () => Date;
  private readonly spawnPty: typeof spawn;

  public constructor(
    private readonly context: IStorageContext,
    private readonly emitOutput: (event: IPlanningOutputEvent) => void,
    options: IPlanningSessionManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.spawnPty = options.spawnPty ?? spawn;
  }

  public ensureSession(input: IEnsurePlanningSessionInput): void {
    const thread = this.requirePlanningThread(input);
    const existingSession = this.sessions.get(thread.id);

    if (existingSession !== undefined) {
      return;
    }

    this.spawnPlanningSession(input, thread);
  }

  public submitInput(input: IEnsurePlanningSessionInput & { readonly bodyText: string }): void {
    const bodyText = input.bodyText.trim();

    if (bodyText.length === 0) {
      return;
    }

    this.ensureSession(input);

    const thread = this.requirePlanningThread(input);
    const session = this.sessions.get(thread.id);

    if (session === undefined) {
      throw new Error(`Planning session is unavailable for thread ${thread.id}`);
    }

    const timestamp = this.now().toISOString();

    upsertChatMessage(this.context, {
      bodyText,
      createdAt: timestamp,
      id: `message-${randomUUID()}`,
      metadataJson: JSON.stringify({
        sessionId: session.workerSessionId,
      }),
      role: "human",
      threadId: thread.id,
    });
    upsertChatThread(this.context, {
      ...thread,
      updatedAt: timestamp,
    });
    this.appendSessionLog(session.logFilePath, `operator> ${bodyText}\n`);
    this.upsertSessionSummary(thread, session, "running");
    session.pty.write(`${bodyText}\r`);
  }

  public writeToSession(terminalKey: string, data: string): void {
    if (data.length === 0) {
      return;
    }

    const session = this.findSessionByTerminalKey(terminalKey);

    if (session === undefined) {
      throw new Error(`Planning session is unavailable for terminal ${terminalKey}`);
    }

    session.pty.write(data);
  }

  public resizeSession(terminalKey: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) {
      return;
    }

    const session = this.findSessionByTerminalKey(terminalKey);

    if (session === undefined) {
      return;
    }

    session.pty.resize(cols, rows);
  }

  public dispose(): void {
    for (const session of this.sessions.values()) {
      session.pty.kill();
    }

    this.sessions.clear();
  }

  private spawnPlanningSession(
    input: IEnsurePlanningSessionInput,
    thread: IChatThreadRecord,
  ): void {
    const project = getProjectById(this.context, input.projectId);

    if (project === null) {
      throw new Error(`Missing project ${input.projectId}`);
    }

    const startedAt = this.now().toISOString();
    const workerSessionId = `session-claude-${randomUUID()}`;
    const terminalKey = this.createTerminalKey(input);
    const logFilePath = this.resolveSessionLogPath(workerSessionId);
    const transcriptRef = this.createTranscriptRef(thread.id, logFilePath);

    this.appendSessionLog(
      logFilePath,
      `[smithly] session ${workerSessionId} started for ${input.scope} planning on ${startedAt}\n`,
    );

    upsertWorkerSession(this.context, {
      createdAt: startedAt,
      id: workerSessionId,
      lastHeartbeatAt: startedAt,
      projectId: input.projectId,
      startedAt,
      status: "starting",
      terminalKey,
      transcriptRef,
      updatedAt: startedAt,
      workerKind: "claude",
    });

    try {
      const mcpConfig = this.buildMcpServerConfig(thread, input);
      const pty = this.spawnPty(
        this.context.config.workers.claude.command,
        this.buildWorkerArgs(this.context.config.workers.claude.command, mcpConfig),
        {
          cols: 120,
          cwd: project.repoPath,
          env: {
            ...process.env,
            SMITHLY_BACKLOG_ITEM_ID: input.backlogItemId ?? "",
            SMITHLY_MCP_CONFIG_JSON: JSON.stringify(mcpConfig),
            SMITHLY_PROJECT_ID: input.projectId,
            SMITHLY_THREAD_ID: thread.id,
            SMITHLY_THREAD_KIND: thread.kind,
          },
          name: "xterm-256color",
          rows: 32,
        },
      );
      const runtimeSession: IPlanningRuntimeSession = {
        ...(input.backlogItemId !== undefined ? { backlogItemId: input.backlogItemId } : {}),
        createdAt: startedAt,
        lineBuffer: "",
        logFilePath,
        projectId: input.projectId,
        pty,
        scope: input.scope,
        startedAt,
        terminalKey,
        threadId: thread.id,
        workerSessionId,
      };

      this.sessions.set(thread.id, runtimeSession);
      this.touchWorkerSession(runtimeSession, "running");
      this.touchThread(thread);
      this.upsertSessionSummary(thread, runtimeSession, "running");

      pty.onData((rawData) => {
        this.appendSessionLog(runtimeSession.logFilePath, rawData);
        this.touchWorkerSession(runtimeSession, "running");
        this.emitOutput({
          entries: this.persistOutput(runtimeSession, rawData),
          rawData,
          terminalKey,
        });
      });
      pty.onExit(({ exitCode }) => {
        const closedSession = this.sessions.get(thread.id);

        if (closedSession === undefined) {
          return;
        }

        const status = exitCode === 0 ? "exited" : "failed";
        const message = `[smithly] Claude planning session ${status} (${exitCode}).`;

        this.touchWorkerSession(closedSession, status);
        this.appendSessionLog(closedSession.logFilePath, `${message}\n`);
        this.emitOutput({
          entries: this.persistOutput(closedSession, `${message}\n`, "system"),
          rawData: `\r\n${message}\r\n`,
          terminalKey,
        });
        this.upsertSessionSummary(thread, closedSession, status);
        this.sessions.delete(thread.id);
      });
    } catch (error: unknown) {
      const failureMessage = `[smithly] Unable to start Claude: ${error instanceof Error ? error.message : String(error)}.`;

      this.touchWorkerSession(
        {
          createdAt: startedAt,
          lineBuffer: "",
          logFilePath,
          projectId: input.projectId,
          scope: input.scope,
          startedAt,
          terminalKey,
          threadId: thread.id,
          workerSessionId,
        } as IPlanningRuntimeSession,
        "failed",
      );
      this.appendSessionLog(logFilePath, `${failureMessage}\n`);
      this.emitOutput({
        entries: this.persistStaticMessage(thread.id, workerSessionId, failureMessage, "system"),
        rawData: `${failureMessage}\r\n`,
        terminalKey,
      });
      this.upsertSessionSummary(
        thread,
        {
          ...(input.backlogItemId !== undefined ? { backlogItemId: input.backlogItemId } : {}),
          createdAt: startedAt,
          lineBuffer: "",
          logFilePath,
          projectId: input.projectId,
          scope: input.scope,
          startedAt,
          terminalKey,
          threadId: thread.id,
          workerSessionId,
        } as IPlanningRuntimeSession,
        "failed",
      );
    }
  }

  private requirePlanningThread(input: IEnsurePlanningSessionInput): IChatThreadRecord {
    const existingThread = listChatThreadsForProject(this.context, input.projectId).find(
      (thread) => {
        if (input.scope === "project") {
          return thread.kind === "project_planning";
        }

        return thread.kind === "task_planning" && thread.backlogItemId === input.backlogItemId;
      },
    );

    if (existingThread !== undefined) {
      return existingThread;
    }

    const timestamp = this.now().toISOString();

    if (input.scope === "project") {
      const projectThread: IChatThreadRecord = {
        createdAt: timestamp,
        id: `thread-project-${randomUUID()}`,
        kind: "project_planning",
        projectId: input.projectId,
        status: "open",
        title: "Project planning",
        updatedAt: timestamp,
      };

      upsertChatThread(this.context, projectThread);
      return projectThread;
    }

    if (input.backlogItemId === undefined) {
      throw new Error("Task planning requires a backlog item.");
    }

    const backlogItem = getBacklogItemById(this.context, input.backlogItemId);

    if (backlogItem === null) {
      throw new Error(`Missing backlog item ${input.backlogItemId}`);
    }

    const taskThread: IChatThreadRecord = {
      backlogItemId: backlogItem.id,
      createdAt: timestamp,
      id: `thread-task-${randomUUID()}`,
      kind: "task_planning",
      projectId: input.projectId,
      status: "open",
      title: `${backlogItem.title} planning`,
      updatedAt: timestamp,
    };

    upsertChatThread(this.context, taskThread);
    return taskThread;
  }

  private createTerminalKey(input: IEnsurePlanningSessionInput): string {
    if (input.scope === "project") {
      return `planning:project:${input.projectId}`;
    }

    if (input.backlogItemId === undefined) {
      throw new Error("Task planning requires a backlog item.");
    }

    return `planning:task:${input.backlogItemId}`;
  }

  private findSessionByTerminalKey(terminalKey: string): IPlanningRuntimeSession | undefined {
    return [...this.sessions.values()].find((session) => session.terminalKey === terminalKey);
  }

  private buildMcpServerConfig(
    thread: IChatThreadRecord,
    input: IEnsurePlanningSessionInput,
  ): IMcpServerConfig {
    return {
      mcpServers: {
        smithly: {
          args: [resolveMcpServerPath()],
          command: process.env.SMITHLY_NODE_COMMAND?.trim() || "node",
          env: {
            SMITHLY_BACKLOG_ITEM_ID: input.backlogItemId ?? "",
            SMITHLY_DATA_DIRECTORY: this.context.config.storage.dataDirectory,
            SMITHLY_PROJECT_ID: input.projectId,
            SMITHLY_THREAD_ID: thread.id,
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

  private touchThread(thread: IChatThreadRecord): void {
    upsertChatThread(this.context, {
      ...thread,
      updatedAt: new Date().toISOString(),
    });
  }

  private touchWorkerSession(
    session: Pick<
      IPlanningRuntimeSession,
      | "createdAt"
      | "logFilePath"
      | "projectId"
      | "startedAt"
      | "terminalKey"
      | "threadId"
      | "workerSessionId"
    >,
    status: IWorkerSessionRecord["status"],
  ): void {
    const timestamp = this.now().toISOString();

    upsertWorkerSession(this.context, {
      createdAt: session.createdAt,
      ...(status === "exited" || status === "failed" ? { endedAt: timestamp } : {}),
      id: session.workerSessionId,
      lastHeartbeatAt: timestamp,
      projectId: session.projectId,
      startedAt: session.startedAt,
      status,
      terminalKey: session.terminalKey,
      transcriptRef: this.createTranscriptRef(session.threadId, session.logFilePath),
      updatedAt: timestamp,
      workerKind: "claude",
    });
  }

  private persistOutput(
    session: Pick<IPlanningRuntimeSession, "lineBuffer" | "threadId" | "workerSessionId">,
    rawData: string,
    role: ChatMessageRole = "claude",
  ): IPlanningOutputEntry[] {
    const sanitizedData = stripAnsi(rawData).replaceAll("\r\n", "\n").replaceAll("\r", "\n");

    session.lineBuffer += sanitizedData;

    const completeLines = session.lineBuffer.split("\n");

    session.lineBuffer = completeLines.pop() ?? "";

    return completeLines.flatMap((line) =>
      this.persistStaticMessage(session.threadId, session.workerSessionId, line, role),
    );
  }

  private persistStaticMessage(
    threadId: string,
    workerSessionId: string,
    bodyText: string,
    role: ChatMessageRole,
  ): IPlanningOutputEntry[] {
    const normalizedBodyText = bodyText.trim();

    if (normalizedBodyText.length === 0) {
      return [];
    }

    const timestamp = this.now().toISOString();
    const message: IChatMessageRecord = {
      bodyText: normalizedBodyText,
      createdAt: timestamp,
      id: `message-${randomUUID()}`,
      metadataJson: JSON.stringify({
        sessionId: workerSessionId,
      }),
      role,
      threadId,
    };

    upsertChatMessage(this.context, message);

    return [
      {
        bodyText: message.bodyText,
        createdAt: message.createdAt,
        id: message.id,
        role: message.role,
      },
    ];
  }

  private createTranscriptRef(threadId: string, logFilePath: string): string {
    return `chat-thread:${threadId}|log-file:${logFilePath}`;
  }

  private resolveSessionLogPath(workerSessionId: string): string {
    return join(this.context.config.storage.dataDirectory, "worker-logs", `${workerSessionId}.log`);
  }

  private appendSessionLog(logFilePath: string, content: string): void {
    mkdirSync(pathDirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, content);
  }

  private upsertSessionSummary(
    thread: IChatThreadRecord,
    session: Pick<
      IPlanningRuntimeSession,
      | "backlogItemId"
      | "createdAt"
      | "logFilePath"
      | "projectId"
      | "scope"
      | "threadId"
      | "workerSessionId"
    >,
    status: IWorkerSessionRecord["status"],
  ): void {
    const timestamp = this.now().toISOString();
    const recentMessages = listChatMessagesForThread(this.context, thread.id).slice(-4);
    const note: IMemoryNoteRecord = {
      ...(session.backlogItemId !== undefined ? { backlogItemId: session.backlogItemId } : {}),
      bodyText: this.buildSessionSummaryBody(thread, session, status, recentMessages),
      createdAt: session.createdAt,
      id: `memory-session-summary-${session.workerSessionId}`,
      noteType: "session_summary",
      projectId: session.projectId,
      sourceThreadId: session.threadId,
      title: `Claude ${session.scope} session snapshot`,
      updatedAt: timestamp,
    };

    upsertMemoryNote(this.context, note);
  }

  private buildSessionSummaryBody(
    thread: IChatThreadRecord,
    session: Pick<
      IPlanningRuntimeSession,
      "backlogItemId" | "logFilePath" | "scope" | "threadId" | "workerSessionId"
    >,
    status: IWorkerSessionRecord["status"],
    recentMessages: readonly IChatMessageRecord[],
  ): string {
    const lines = [
      `scope: ${session.scope}`,
      `status: ${status}`,
      `thread: ${thread.title} (${session.threadId})`,
      `workerSessionId: ${session.workerSessionId}`,
      `transcriptRef: ${this.createTranscriptRef(session.threadId, session.logFilePath)}`,
      `logFilePath: ${session.logFilePath}`,
      ...(session.backlogItemId !== undefined ? [`backlogItemId: ${session.backlogItemId}`] : []),
    ];

    if (recentMessages.length === 0) {
      lines.push("recentMessages: none");
    } else {
      lines.push("recentMessages:");
      lines.push(
        ...recentMessages.map((message) => {
          return `- ${message.role}: ${message.bodyText}`;
        }),
      );
    }

    return lines.join("\n");
  }
}

function resolveMcpServerPath(): string {
  return join(dirname(), "../../../packages/mcp-server/src/main.js");
}

function dirname(): string {
  return fileURLToPath(new URL(".", import.meta.url));
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

import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawn, type IPty } from "node-pty";

import type {
  ChatMessageRole,
  IChatMessageRecord,
  IChatThreadRecord,
  IWorkerSessionRecord,
} from "@smithly/core";
import {
  getBacklogItemById,
  getProjectById,
  listChatThreadsForProject,
  upsertChatMessage,
  upsertChatThread,
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

export class PlanningSessionManager {
  private readonly sessions = new Map<string, IPlanningRuntimeSession>();

  public constructor(
    private readonly context: IStorageContext,
    private readonly emitOutput: (event: IPlanningOutputEvent) => void,
  ) {}

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

    const timestamp = new Date().toISOString();

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
    session.pty.write(`${bodyText}\r`);
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

    const startedAt = new Date().toISOString();
    const workerSessionId = `session-claude-${randomUUID()}`;
    const terminalKey = this.createTerminalKey(input);

    upsertWorkerSession(this.context, {
      createdAt: startedAt,
      id: workerSessionId,
      lastHeartbeatAt: startedAt,
      projectId: input.projectId,
      startedAt,
      status: "starting",
      terminalKey,
      transcriptRef: `chat-thread:${thread.id}`,
      updatedAt: startedAt,
      workerKind: "claude",
    });

    try {
      const mcpConfig = this.buildMcpServerConfig(thread, input);
      const pty = spawn(
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

      pty.onData((rawData) => {
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
        this.emitOutput({
          entries: this.persistOutput(closedSession, `${message}\n`, "system"),
          rawData: `\r\n${message}\r\n`,
          terminalKey,
        });
        this.sessions.delete(thread.id);
      });
    } catch (error: unknown) {
      const failureMessage = `[smithly] Unable to start Claude: ${error instanceof Error ? error.message : String(error)}.`;

      this.touchWorkerSession(
        {
          createdAt: startedAt,
          lineBuffer: "",
          projectId: input.projectId,
          scope: input.scope,
          startedAt,
          terminalKey,
          threadId: thread.id,
          workerSessionId,
        } as IPlanningRuntimeSession,
        "failed",
      );
      this.emitOutput({
        entries: this.persistStaticMessage(thread.id, workerSessionId, failureMessage, "system"),
        rawData: `${failureMessage}\r\n`,
        terminalKey,
      });
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

    const timestamp = new Date().toISOString();

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
      "createdAt" | "projectId" | "startedAt" | "terminalKey" | "threadId" | "workerSessionId"
    >,
    status: IWorkerSessionRecord["status"],
  ): void {
    const timestamp = new Date().toISOString();

    upsertWorkerSession(this.context, {
      createdAt: session.createdAt,
      ...(status === "exited" || status === "failed" ? { endedAt: timestamp } : {}),
      id: session.workerSessionId,
      lastHeartbeatAt: timestamp,
      projectId: session.projectId,
      startedAt: session.startedAt,
      status,
      terminalKey: session.terminalKey,
      transcriptRef: `chat-thread:${session.threadId}`,
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

    const timestamp = new Date().toISOString();
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

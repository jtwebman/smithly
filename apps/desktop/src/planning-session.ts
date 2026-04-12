import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname as pathDirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawn, type IPty } from "node-pty";

import type {
  ApprovalStatus,
  ApprovalRequester,
  BlockerStatus,
  BlockerType,
  ChatMessageRole,
  IChatMessageRecord,
  IChatThreadRecord,
  IMemoryNoteRecord,
  IWorkerSessionRecord,
  MemoryNoteType,
  TaskRunStatus,
} from "@smithly/core";
import {
  getBacklogItemById,
  getProjectById,
  listApprovalsForProject,
  listBacklogItemsForProject,
  listBlockersForProject,
  listChatMessagesForThread,
  listChatThreadsForProject,
  listTaskRunsForProject,
  upsertApproval,
  upsertBlocker,
  upsertChatMessage,
  upsertChatThread,
  upsertMemoryNote,
  upsertTaskRun,
  upsertWorkerSession,
  type IStorageContext,
} from "@smithly/storage";

import { queueRequiredReviewRun, reconcileTaskReviewState } from "./task-review-policy.ts";
import { queueProjectVerificationRuns } from "./verification-manager.ts";

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

interface IHookEnvelope {
  readonly type: "approval_request" | "blocker" | "memory_note" | "task_outcome";
  readonly payload: Record<string, unknown>;
}

interface IPlanningSessionManagerOptions {
  readonly now?: () => Date;
  readonly spawnPty?: typeof spawn;
}

export class PlanningSessionManager {
  private readonly sessions = new Map<string, IPlanningRuntimeSession>();
  private readonly pendingPauseRequests = new Map<string, Promise<void>>();
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

    if (input.scope === "project") {
      this.refreshProjectPlanningContext(thread, input.projectId);
    }

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
    this.pendingPauseRequests.clear();
  }

  public requestProjectPause(
    projectId: string,
    reason = "Pause requested by Smithly.",
  ): Promise<void> {
    const session = [...this.sessions.values()].find((candidate) => {
      return candidate.projectId === projectId && candidate.scope === "project";
    });

    if (session === undefined) {
      return Promise.resolve();
    }

    const existingRequest = this.pendingPauseRequests.get(session.threadId);

    if (existingRequest !== undefined) {
      return existingRequest;
    }

    const pauseRequest = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          session.pty.kill();
        } catch {
          this.pendingPauseRequests.delete(session.threadId);
          resolve();
          return;
        }

        setTimeout(() => {
          if (this.sessions.has(session.threadId)) {
            this.touchWorkerSession(session, "failed");
            this.upsertSessionSummary(
              this.requirePlanningThread({
                projectId,
                scope: "project",
              }),
              session,
              "failed",
            );
            this.sessions.delete(session.threadId);
          }

          this.pendingPauseRequests.delete(session.threadId);
          resolve();
        }, 100);
      }, 1_500);
      const resolvePauseRequest = () => {
        clearTimeout(timeout);
        this.pendingPauseRequests.delete(session.threadId);
        resolve();
      };

      this.touchWorkerSession(session, "waiting");
      this.appendSessionLog(
        session.logFilePath,
        `[smithly] pause requested for project ${projectId}: ${reason}\n`,
      );
      this.upsertSessionSummary(
        this.requirePlanningThread({
          projectId,
          scope: "project",
        }),
        session,
        "waiting",
      );
      session.pty.write(`/pause ${reason}\r`);

      const pollForExit = () => {
        if (!this.sessions.has(session.threadId)) {
          resolvePauseRequest();
          return;
        }

        setTimeout(pollForExit, 25);
      };

      pollForExit();
    });

    this.pendingPauseRequests.set(session.threadId, pauseRequest);
    return pauseRequest;
  }

  private refreshProjectPlanningContext(thread: IChatThreadRecord, projectId: string): void {
    if (thread.kind !== "project_planning") {
      return;
    }

    const timestamp = this.now().toISOString();

    upsertChatMessage(this.context, {
      bodyText: this.buildProjectPlanningContextSummary(projectId),
      createdAt: timestamp,
      id: `message-project-context-${projectId}`,
      metadataJson: JSON.stringify({
        kind: "project_context_summary",
      }),
      role: "system",
      threadId: thread.id,
    });
    upsertChatThread(this.context, {
      ...thread,
      updatedAt: timestamp,
    });
  }

  private buildProjectPlanningContextSummary(projectId: string): string {
    const project = getProjectById(this.context, projectId);

    if (project === null) {
      throw new Error(`Missing project ${projectId}`);
    }

    const backlogItems = listBacklogItemsForProject(this.context, projectId);
    const backlogItemTitles = new Map(
      backlogItems.map((backlogItem) => [backlogItem.id, backlogItem.title] as const),
    );
    const activeTaskRuns = listTaskRunsForProject(this.context, projectId).filter((taskRun) => {
      return ["awaiting_review", "blocked", "queued", "running"].includes(taskRun.status);
    });
    const approvedBacklogItems = backlogItems.filter(
      (backlogItem) => backlogItem.status === "approved",
    );
    const draftBacklogItems = backlogItems.filter((backlogItem) => backlogItem.status === "draft");
    const pendingApprovals = listApprovalsForProject(this.context, projectId).filter((approval) => {
      return approval.status === "pending";
    });
    const summarizeTitles = (items: readonly { readonly title: string }[]): string => {
      return (
        items
          .slice(0, 3)
          .map((item) => item.title)
          .join("; ") || "none"
      );
    };
    const activeTaskSummary =
      activeTaskRuns.length === 0
        ? "none"
        : activeTaskRuns
            .slice(0, 3)
            .map((taskRun) => {
              return `${backlogItemTitles.get(taskRun.backlogItemId) ?? taskRun.backlogItemId} (${taskRun.status})`;
            })
            .join("; ");

    return [
      "Project context summary:",
      `Project: ${project.name} (status: ${project.status})`,
      `Active task context: ${activeTaskSummary}`,
      `Approved work ready for planning/review: ${approvedBacklogItems.length} | ${summarizeTitles(approvedBacklogItems)}`,
      `Draft backlog needing clarification: ${draftBacklogItems.length} | ${summarizeTitles(draftBacklogItems)}`,
      `Pending approvals: ${pendingApprovals.length}`,
    ].join("\n");
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
        const entries = this.persistOutput(runtimeSession, rawData);
        this.emitOutput({
          entries,
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
        this.pendingPauseRequests.delete(thread.id);
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
    session: Pick<
      IPlanningRuntimeSession,
      "backlogItemId" | "lineBuffer" | "projectId" | "threadId" | "workerSessionId"
    >,
    rawData: string,
    role: ChatMessageRole = "claude",
  ): IPlanningOutputEntry[] {
    const sanitizedData = stripAnsi(rawData).replaceAll("\r\n", "\n").replaceAll("\r", "\n");

    session.lineBuffer += sanitizedData;

    const completeLines = session.lineBuffer.split("\n");

    session.lineBuffer = completeLines.pop() ?? "";

    return completeLines.flatMap((line) => {
      if (this.applyHookLine(session, line)) {
        return [];
      }

      return this.persistStaticMessage(session.threadId, session.workerSessionId, line, role);
    });
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

  private applyHookLine(
    session: Pick<
      IPlanningRuntimeSession,
      "backlogItemId" | "projectId" | "threadId" | "workerSessionId"
    >,
    bodyText: string,
  ): boolean {
    const envelope = parseHookEnvelope(bodyText);

    if (envelope === null) {
      return false;
    }

    switch (envelope.type) {
      case "approval_request":
        this.ingestApprovalRequest(session, envelope.payload);
        return true;
      case "blocker":
        this.ingestBlocker(session, envelope.payload);
        return true;
      case "memory_note":
        this.ingestMemoryNote(session, envelope.payload);
        return true;
      case "task_outcome":
        this.ingestTaskOutcome(session, envelope.payload);
        return true;
      default:
        return false;
    }
  }

  private ingestApprovalRequest(
    session: Pick<IPlanningRuntimeSession, "backlogItemId" | "projectId" | "threadId">,
    payload: Record<string, unknown>,
  ): void {
    const timestamp = this.now().toISOString();
    const approvalId = readOptionalString(payload.id) ?? `approval-hook-${randomUUID()}`;
    const decisionBy = readOptionalString(payload.decisionBy);
    const decidedAt = readOptionalString(payload.decidedAt);
    const existingApproval = listApprovalsForProject(this.context, session.projectId).find(
      (approval) => approval.id === approvalId,
    );

    upsertApproval(this.context, {
      ...(session.backlogItemId !== undefined ? { backlogItemId: session.backlogItemId } : {}),
      createdAt: existingApproval?.createdAt ?? timestamp,
      detail: readRequiredString(payload.detail, "approval_request.detail"),
      id: approvalId,
      projectId: session.projectId,
      requestedBy: readEnum<ApprovalRequester>(
        payload.requestedBy,
        ["system", "claude", "codex", "human"],
        "approval_request.requestedBy",
      ),
      status: readEnum<ApprovalStatus>(
        payload.status,
        ["pending", "approved", "rejected", "deferred"],
        "approval_request.status",
      ),
      title: readRequiredString(payload.title, "approval_request.title"),
      updatedAt: timestamp,
      ...(existingApproval?.taskRunId !== undefined
        ? { taskRunId: existingApproval.taskRunId }
        : {}),
      ...(decisionBy !== undefined ? { decisionBy } : {}),
      ...(decidedAt !== undefined ? { decidedAt } : {}),
    });
    this.ingestHookMemoryNote(
      session,
      "Approval request",
      `${approvalId} updated from Claude hook.`,
    );
  }

  private ingestBlocker(
    session: Pick<IPlanningRuntimeSession, "backlogItemId" | "projectId" | "threadId">,
    payload: Record<string, unknown>,
  ): void {
    const timestamp = this.now().toISOString();
    const blockerId = readOptionalString(payload.id) ?? `blocker-hook-${randomUUID()}`;
    const resolutionNote = readOptionalString(payload.resolutionNote);
    const resolvedAt = readOptionalString(payload.resolvedAt);
    const existingBlocker = listBlockersForProject(this.context, session.projectId).find(
      (blocker) => blocker.id === blockerId,
    );

    upsertBlocker(this.context, {
      ...(session.backlogItemId !== undefined ? { backlogItemId: session.backlogItemId } : {}),
      blockerType: readEnum<BlockerType>(
        payload.blockerType,
        ["policy", "helper_model", "human", "system"],
        "blocker.blockerType",
      ),
      createdAt: existingBlocker?.createdAt ?? timestamp,
      detail: readRequiredString(payload.detail, "blocker.detail"),
      id: blockerId,
      projectId: session.projectId,
      status: readEnum<BlockerStatus>(payload.status, ["open", "resolved"], "blocker.status"),
      title: readRequiredString(payload.title, "blocker.title"),
      updatedAt: timestamp,
      ...(existingBlocker?.taskRunId !== undefined ? { taskRunId: existingBlocker.taskRunId } : {}),
      ...(resolutionNote !== undefined ? { resolutionNote } : {}),
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    });
    this.ingestHookMemoryNote(session, "Blocker update", `${blockerId} updated from Claude hook.`);
  }

  private ingestMemoryNote(
    session: Pick<IPlanningRuntimeSession, "backlogItemId" | "projectId" | "threadId">,
    payload: Record<string, unknown>,
  ): void {
    const timestamp = this.now().toISOString();
    const noteId = readOptionalString(payload.id) ?? `memory-hook-${randomUUID()}`;

    upsertMemoryNote(this.context, {
      ...(session.backlogItemId !== undefined ? { backlogItemId: session.backlogItemId } : {}),
      bodyText: readRequiredString(payload.bodyText, "memory_note.bodyText"),
      createdAt: timestamp,
      id: noteId,
      noteType: readEnum<MemoryNoteType>(
        payload.noteType,
        ["fact", "decision", "note", "session_summary"],
        "memory_note.noteType",
      ),
      projectId: session.projectId,
      sourceThreadId: session.threadId,
      title: readRequiredString(payload.title, "memory_note.title"),
      updatedAt: timestamp,
    });
  }

  private ingestTaskOutcome(
    session: Pick<
      IPlanningRuntimeSession,
      "backlogItemId" | "projectId" | "threadId" | "workerSessionId"
    >,
    payload: Record<string, unknown>,
  ): void {
    if (session.backlogItemId === undefined) {
      throw new Error("task_outcome hooks require a task-scoped planning session.");
    }

    const timestamp = this.now().toISOString();
    const taskRunId = readOptionalString(payload.id) ?? `taskrun-hook-${randomUUID()}`;
    const existingTaskRun = listTaskRunsForProject(this.context, session.projectId).find(
      (taskRun) => taskRun.id === taskRunId,
    );
    const status = readEnum<TaskRunStatus>(
      payload.status,
      ["queued", "running", "blocked", "awaiting_review", "done", "failed", "cancelled"],
      "task_outcome.status",
    );

    upsertTaskRun(this.context, {
      assignedWorker: "claude",
      backlogItemId: session.backlogItemId,
      createdAt: existingTaskRun?.createdAt ?? timestamp,
      id: taskRunId,
      projectId: session.projectId,
      status,
      summaryText: readRequiredString(payload.summaryText, "task_outcome.summaryText"),
      updatedAt: timestamp,
      workerSessionId: session.workerSessionId,
      ...(existingTaskRun?.startedAt !== undefined
        ? { startedAt: existingTaskRun.startedAt }
        : status !== "queued"
          ? { startedAt: timestamp }
          : {}),
      ...(status === "done" || status === "failed" || status === "cancelled"
        ? { completedAt: timestamp }
        : {}),
    });

    if (status === "done") {
      const completedTaskRun = listTaskRunsForProject(this.context, session.projectId).find(
        (taskRun) => taskRun.id === taskRunId,
      );

      if (completedTaskRun !== undefined) {
        queueProjectVerificationRuns(this.context, completedTaskRun, timestamp);
        queueRequiredReviewRun(this.context, completedTaskRun, timestamp);
        reconcileTaskReviewState(this.context, completedTaskRun.id, timestamp);
      }
    }

    this.ingestHookMemoryNote(session, "Task outcome", `${taskRunId} updated from Claude hook.`);
  }

  private ingestHookMemoryNote(
    session: Pick<IPlanningRuntimeSession, "backlogItemId" | "projectId" | "threadId">,
    title: string,
    bodyText: string,
  ): void {
    const timestamp = this.now().toISOString();

    upsertMemoryNote(this.context, {
      ...(session.backlogItemId !== undefined ? { backlogItemId: session.backlogItemId } : {}),
      bodyText,
      createdAt: timestamp,
      id: `memory-hook-${randomUUID()}`,
      noteType: "note",
      projectId: session.projectId,
      sourceThreadId: session.threadId,
      title,
      updatedAt: timestamp,
    });
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

function parseHookEnvelope(bodyText: string): IHookEnvelope | null {
  const normalizedBodyText = bodyText.trim();

  if (!normalizedBodyText.startsWith("smithly-hook:")) {
    return null;
  }

  const serializedPayload = normalizedBodyText.slice("smithly-hook:".length).trim();

  if (serializedPayload.length === 0) {
    throw new Error("smithly-hook payload is empty.");
  }

  const parsedPayload = JSON.parse(serializedPayload) as unknown;

  if (!isObjectRecord(parsedPayload)) {
    throw new Error("smithly-hook payload must be an object.");
  }

  return {
    payload: isObjectRecord(parsedPayload.payload) ? parsedPayload.payload : {},
    type: readEnum(
      parsedPayload.type,
      ["approval_request", "blocker", "memory_note", "task_outcome"],
      "smithly-hook.type",
    ),
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function readEnum<TValue extends string>(
  value: unknown,
  candidates: readonly TValue[],
  fieldName: string,
): TValue {
  if (typeof value !== "string" || !candidates.includes(value as TValue)) {
    throw new Error(`${fieldName} must be one of: ${candidates.join(", ")}.`);
  }

  return value as TValue;
}

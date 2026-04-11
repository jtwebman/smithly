import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname as pathDirname, join } from "node:path";

import { spawn, type IPty } from "node-pty";

import type {
  ApprovalStatus,
  ApprovalRequester,
  BlockerStatus,
  BlockerType,
  IMemoryNoteRecord,
  ITaskRunRecord,
  IWorkerSessionRecord,
  MemoryNoteType,
  TaskRunStatus,
} from "@smithly/core";
import {
  getBacklogItemById,
  getProjectById,
  listApprovalsForProject,
  listBlockersForProject,
  listMemoryNotesForProject,
  listVerificationRunsForTask,
  listProjects,
  listTaskRunsForProject,
  parseProjectMetadata,
  startCodingTask,
  upsertApproval,
  upsertBlocker,
  upsertMemoryNote,
  upsertTaskRun,
  upsertVerificationRun,
  upsertWorkerSession,
  type IStorageContext,
} from "@smithly/storage";

export interface ICodexOutputEvent {
  readonly terminalKey: string;
  readonly rawData: string;
}

export interface IStartCodexSessionInput {
  readonly backlogItemId: string;
  readonly projectId: string;
  readonly summaryText?: string;
}

interface IHookEnvelope {
  readonly type: "approval_request" | "blocker" | "memory_note" | "task_outcome";
  readonly payload: Record<string, unknown>;
}

interface ICodexRuntimeSession {
  readonly backlogItemId: string;
  readonly createdAt: string;
  readonly logFilePath: string;
  readonly projectId: string;
  readonly pty: IPty;
  readonly startedAt: string;
  readonly taskRunId: string;
  readonly terminalKey: string;
  readonly workerSessionId: string;
  lineBuffer: string;
}

interface ICodexSessionManagerOptions {
  readonly now?: () => Date;
  readonly spawnPty?: typeof spawn;
}

export class CodexSessionManager {
  private readonly sessions = new Map<string, ICodexRuntimeSession>();
  private readonly now: () => Date;
  private readonly spawnPty: typeof spawn;

  public constructor(
    private readonly context: IStorageContext,
    private readonly emitOutput: (event: ICodexOutputEvent) => void,
    options: ICodexSessionManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.spawnPty = options.spawnPty ?? spawn;
  }

  public startSession(input: IStartCodexSessionInput): ITaskRunRecord {
    const taskRun = startCodingTask(this.context, {
      backlogItemId: input.backlogItemId,
      assignedWorker: "codex",
      ...(input.summaryText !== undefined ? { summaryText: input.summaryText } : {}),
    });
    const existingSession = this.sessions.get(taskRun.id);

    if (existingSession !== undefined) {
      return taskRun;
    }

    this.spawnCodexSession(taskRun, input.projectId);
    return taskRun;
  }

  public ensureSession(taskRunId: string): void {
    if (this.sessions.has(taskRunId)) {
      return;
    }

    const taskRun = this.requireTaskRun(taskRunId);
    this.spawnCodexSession(taskRun, taskRun.projectId);
  }

  public writeToSession(terminalKey: string, data: string): void {
    if (data.length === 0) {
      return;
    }

    const session = this.findSessionByTerminalKey(terminalKey);

    if (session === undefined) {
      throw new Error(`Codex session is unavailable for terminal ${terminalKey}`);
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

  private spawnCodexSession(taskRun: ITaskRunRecord, projectId: string): void {
    const project = getProjectById(this.context, projectId);

    if (project === null) {
      throw new Error(`Missing project ${projectId}`);
    }

    const startedAt = this.now().toISOString();
    const workerSessionId = `session-codex-${randomUUID()}`;
    const terminalKey = `codex:${taskRun.id}`;
    const logFilePath = this.resolveSessionLogPath(workerSessionId);
    const transcriptRef = this.createTranscriptRef(taskRun.id, logFilePath);

    this.appendSessionLog(
      logFilePath,
      `[smithly] session ${workerSessionId} started for codex task ${taskRun.id} on ${startedAt}\n`,
    );

    upsertWorkerSession(this.context, {
      createdAt: startedAt,
      id: workerSessionId,
      lastHeartbeatAt: startedAt,
      projectId,
      startedAt,
      status: "starting",
      terminalKey,
      transcriptRef,
      updatedAt: startedAt,
      workerKind: "codex",
    });

    try {
      const pty = this.spawnPty(
        this.context.config.workers.codex.command,
        [...this.context.config.workers.codex.args],
        {
          cols: 120,
          cwd: project.repoPath,
          env: {
            ...process.env,
            SMITHLY_BACKLOG_ITEM_ID: taskRun.backlogItemId,
            SMITHLY_PROJECT_ID: projectId,
            SMITHLY_TASK_RUN_ID: taskRun.id,
            SMITHLY_WORKER_SESSION_ID: workerSessionId,
          },
          name: "xterm-256color",
          rows: 32,
        },
      );
      const runtimeSession: ICodexRuntimeSession = {
        backlogItemId: taskRun.backlogItemId,
        createdAt: startedAt,
        lineBuffer: "",
        logFilePath,
        projectId,
        pty,
        startedAt,
        taskRunId: taskRun.id,
        terminalKey,
        workerSessionId,
      };

      this.sessions.set(taskRun.id, runtimeSession);
      this.touchWorkerSession(runtimeSession, "running");
      this.touchTaskRun(runtimeSession, taskRun, "running");
      this.upsertSessionSummary(runtimeSession, "running");

      pty.onData((rawData) => {
        this.appendSessionLog(runtimeSession.logFilePath, rawData);
        this.touchWorkerSession(runtimeSession, "running");
        this.emitOutput({
          rawData,
          terminalKey,
        });
        this.persistOutput(runtimeSession, rawData);
      });
      pty.onExit(({ exitCode }) => {
        const closedSession = this.sessions.get(taskRun.id);

        if (closedSession === undefined) {
          return;
        }

        const status = exitCode === 0 ? "exited" : "failed";
        const message = `[smithly] Codex task session ${status} (${exitCode}).`;
        const currentTaskRun = this.requireTaskRun(closedSession.taskRunId);
        const nextTaskStatus =
          exitCode === 0
            ? ["done", "cancelled", "failed"].includes(currentTaskRun.status)
              ? currentTaskRun.status
              : "awaiting_review"
            : "failed";

        this.touchWorkerSession(closedSession, status);
        this.touchTaskRun(closedSession, currentTaskRun, nextTaskStatus);
        this.appendSessionLog(closedSession.logFilePath, `${message}\n`);
        this.emitOutput({
          rawData: `\r\n${message}\r\n`,
          terminalKey,
        });
        this.upsertSessionSummary(closedSession, status);
        this.sessions.delete(taskRun.id);
      });
    } catch (error: unknown) {
      const failureMessage = `[smithly] Unable to start Codex: ${error instanceof Error ? error.message : String(error)}.`;

      this.touchWorkerSession(
        {
          createdAt: startedAt,
          logFilePath,
          projectId,
          startedAt,
          taskRunId: taskRun.id,
          terminalKey,
          workerSessionId,
        },
        "failed",
      );
      this.touchTaskRun(
        {
          startedAt,
          taskRunId: taskRun.id,
          workerSessionId,
        },
        taskRun,
        "failed",
      );
      this.appendSessionLog(logFilePath, `${failureMessage}\n`);
      this.emitOutput({
        rawData: `${failureMessage}\r\n`,
        terminalKey,
      });
      this.upsertSessionSummary(
        {
          backlogItemId: taskRun.backlogItemId,
          createdAt: startedAt,
          logFilePath,
          projectId,
          taskRunId: taskRun.id,
          workerSessionId,
        },
        "failed",
      );
    }
  }

  private requireTaskRun(taskRunId: string): ITaskRunRecord {
    const taskRun = listTaskRunsForProject(
      this.context,
      this.requireProjectIdForTaskRun(taskRunId),
    ).find((candidate) => candidate.id === taskRunId);

    if (taskRun === undefined) {
      throw new Error(`Missing task run ${taskRunId}`);
    }

    return taskRun;
  }

  private requireProjectIdForTaskRun(taskRunId: string): string {
    for (const project of getAllProjectIds(this.context)) {
      if (
        listTaskRunsForProject(this.context, project).some((taskRun) => taskRun.id === taskRunId)
      ) {
        return project;
      }
    }

    throw new Error(`Missing task run ${taskRunId}`);
  }

  private findSessionByTerminalKey(terminalKey: string): ICodexRuntimeSession | undefined {
    return [...this.sessions.values()].find((session) => session.terminalKey === terminalKey);
  }

  private touchWorkerSession(
    session: Pick<
      ICodexRuntimeSession,
      | "createdAt"
      | "logFilePath"
      | "projectId"
      | "startedAt"
      | "taskRunId"
      | "terminalKey"
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
      transcriptRef: this.createTranscriptRef(session.taskRunId, session.logFilePath),
      updatedAt: timestamp,
      workerKind: "codex",
    });
  }

  private touchTaskRun(
    session: Pick<ICodexRuntimeSession, "startedAt" | "taskRunId" | "workerSessionId">,
    taskRun: ITaskRunRecord,
    status: TaskRunStatus,
  ): void {
    const timestamp = this.now().toISOString();

    upsertTaskRun(this.context, {
      ...taskRun,
      ...(taskRun.startedAt !== undefined || status === "queued"
        ? {}
        : { startedAt: session.startedAt }),
      ...(status === "done" || status === "failed" || status === "cancelled"
        ? { completedAt: timestamp }
        : {}),
      status,
      updatedAt: timestamp,
      workerSessionId: session.workerSessionId,
    });
  }

  private persistOutput(
    session: Pick<
      ICodexRuntimeSession,
      "backlogItemId" | "lineBuffer" | "projectId" | "taskRunId" | "workerSessionId"
    >,
    rawData: string,
  ): void {
    const sanitizedData = stripAnsi(rawData).replaceAll("\r\n", "\n").replaceAll("\r", "\n");

    session.lineBuffer += sanitizedData;

    const completeLines = session.lineBuffer.split("\n");

    session.lineBuffer = completeLines.pop() ?? "";

    for (const line of completeLines) {
      this.applyHookLine(session, line);
    }
  }

  private applyHookLine(
    session: Pick<
      ICodexRuntimeSession,
      "backlogItemId" | "projectId" | "taskRunId" | "workerSessionId"
    >,
    bodyText: string,
  ): void {
    const envelope = parseHookEnvelope(bodyText);

    if (envelope === null) {
      return;
    }

    switch (envelope.type) {
      case "approval_request":
        this.ingestApprovalRequest(session, envelope.payload);
        return;
      case "blocker":
        this.ingestBlocker(session, envelope.payload);
        return;
      case "memory_note":
        this.ingestMemoryNote(session, envelope.payload);
        return;
      case "task_outcome":
        this.ingestTaskOutcome(session, envelope.payload);
        return;
      default:
        return;
    }
  }

  private ingestApprovalRequest(
    session: Pick<ICodexRuntimeSession, "backlogItemId" | "projectId" | "taskRunId">,
    payload: Record<string, unknown>,
  ): void {
    const timestamp = this.now().toISOString();
    const approvalId = readOptionalString(payload.id) ?? `approval-hook-${randomUUID()}`;
    const existingApproval = listApprovalsForProject(this.context, session.projectId).find(
      (approval) => approval.id === approvalId,
    );

    upsertApproval(this.context, {
      backlogItemId: session.backlogItemId,
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
      taskRunId: session.taskRunId,
      title: readRequiredString(payload.title, "approval_request.title"),
      updatedAt: timestamp,
    });
  }

  private ingestBlocker(
    session: Pick<ICodexRuntimeSession, "backlogItemId" | "projectId" | "taskRunId">,
    payload: Record<string, unknown>,
  ): void {
    const timestamp = this.now().toISOString();
    const blockerId = readOptionalString(payload.id) ?? `blocker-hook-${randomUUID()}`;
    const existingBlocker = listBlockersForProject(this.context, session.projectId).find(
      (blocker) => blocker.id === blockerId,
    );
    const resolutionNote = readOptionalString(payload.resolutionNote);
    const resolvedAt = readOptionalString(payload.resolvedAt);

    upsertBlocker(this.context, {
      backlogItemId: session.backlogItemId,
      blockerType: readEnum<BlockerType>(
        payload.blockerType,
        ["policy", "helper_model", "human", "system"],
        "blocker.blockerType",
      ),
      createdAt: existingBlocker?.createdAt ?? timestamp,
      detail: readRequiredString(payload.detail, "blocker.detail"),
      id: blockerId,
      projectId: session.projectId,
      ...(resolutionNote !== undefined ? { resolutionNote } : {}),
      ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      status: readEnum<BlockerStatus>(payload.status, ["open", "resolved"], "blocker.status"),
      taskRunId: session.taskRunId,
      title: readRequiredString(payload.title, "blocker.title"),
      updatedAt: timestamp,
    });
  }

  private ingestMemoryNote(
    session: Pick<ICodexRuntimeSession, "backlogItemId" | "projectId" | "taskRunId">,
    payload: Record<string, unknown>,
  ): void {
    const timestamp = this.now().toISOString();
    const noteId = readOptionalString(payload.id) ?? `memory-hook-${randomUUID()}`;

    upsertMemoryNote(this.context, {
      backlogItemId: session.backlogItemId,
      bodyText: readRequiredString(payload.bodyText, "memory_note.bodyText"),
      createdAt: timestamp,
      id: noteId,
      noteType: readEnum<MemoryNoteType>(
        payload.noteType,
        ["fact", "decision", "note", "session_summary"],
        "memory_note.noteType",
      ),
      projectId: session.projectId,
      taskRunId: session.taskRunId,
      title: readRequiredString(payload.title, "memory_note.title"),
      updatedAt: timestamp,
    });
  }

  private ingestTaskOutcome(
    session: Pick<
      ICodexRuntimeSession,
      "backlogItemId" | "projectId" | "taskRunId" | "workerSessionId"
    >,
    payload: Record<string, unknown>,
  ): void {
    const timestamp = this.now().toISOString();
    const taskRun = this.requireTaskRun(session.taskRunId);
    const status = readEnum<TaskRunStatus>(
      payload.status,
      ["queued", "running", "blocked", "awaiting_review", "done", "failed", "cancelled"],
      "task_outcome.status",
    );

    upsertTaskRun(this.context, {
      ...taskRun,
      ...(taskRun.startedAt !== undefined || status === "queued" ? {} : { startedAt: timestamp }),
      ...(status === "done" || status === "failed" || status === "cancelled"
        ? { completedAt: timestamp }
        : {}),
      status,
      summaryText: readRequiredString(payload.summaryText, "task_outcome.summaryText"),
      updatedAt: timestamp,
      workerSessionId: session.workerSessionId,
    });

    if (status === "done") {
      const backlogItem = getBacklogItemById(this.context, session.backlogItemId);

      if (backlogItem !== null) {
        upsertMemoryNote(this.context, {
          backlogItemId: backlogItem.id,
          bodyText: `Codex reported completion for ${taskRun.id}.`,
          createdAt: timestamp,
          id: `memory-codex-complete-${taskRun.id}`,
          noteType: "note",
          projectId: session.projectId,
          taskRunId: taskRun.id,
          title: "Codex task completed",
          updatedAt: timestamp,
        });
      }

      this.queueProjectVerificationRuns(taskRun, timestamp);
    }

    this.upsertSessionSummary(
      {
        backlogItemId: session.backlogItemId,
        createdAt: taskRun.createdAt,
        logFilePath: this.resolveSessionLogPath(session.workerSessionId),
        projectId: session.projectId,
        taskRunId: session.taskRunId,
        workerSessionId: session.workerSessionId,
      },
      "running",
    );
  }

  private createTranscriptRef(taskRunId: string, logFilePath: string): string {
    return `task-run:${taskRunId}|log-file:${logFilePath}`;
  }

  private queueProjectVerificationRuns(taskRun: ITaskRunRecord, timestamp: string): void {
    const project = getProjectById(this.context, taskRun.projectId);

    if (project === null) {
      return;
    }

    const verificationCommands = parseProjectMetadata(project).verificationCommands;
    const existingCommandSet = new Set(
      listVerificationRunsForTask(this.context, taskRun.id).map((verificationRun) => {
        return verificationRun.commandText;
      }),
    );

    for (const commandText of verificationCommands) {
      if (existingCommandSet.has(commandText)) {
        continue;
      }

      upsertVerificationRun(this.context, {
        commandText,
        createdAt: timestamp,
        id: `verification-${randomUUID()}`,
        projectId: taskRun.projectId,
        status: "queued",
        taskRunId: taskRun.id,
        updatedAt: timestamp,
      });
    }
  }

  private resolveSessionLogPath(workerSessionId: string): string {
    return join(this.context.config.storage.dataDirectory, "worker-logs", `${workerSessionId}.log`);
  }

  private appendSessionLog(logFilePath: string, content: string): void {
    mkdirSync(pathDirname(logFilePath), { recursive: true });
    appendFileSync(logFilePath, content);
  }

  private upsertSessionSummary(
    session: Pick<
      ICodexRuntimeSession,
      "backlogItemId" | "createdAt" | "logFilePath" | "projectId" | "taskRunId" | "workerSessionId"
    >,
    status: IWorkerSessionRecord["status"],
  ): void {
    const timestamp = this.now().toISOString();
    const taskRun = this.requireTaskRun(session.taskRunId);
    const existingSummary = listMemoryNotesForProject(this.context, session.projectId).find(
      (note) => note.id === `memory-session-summary-${session.workerSessionId}`,
    );
    const note: IMemoryNoteRecord = {
      backlogItemId: session.backlogItemId,
      bodyText: [
        "worker: codex",
        `status: ${status}`,
        `taskRunId: ${session.taskRunId}`,
        `workerSessionId: ${session.workerSessionId}`,
        `transcriptRef: ${this.createTranscriptRef(session.taskRunId, session.logFilePath)}`,
        `logFilePath: ${session.logFilePath}`,
        `summaryText: ${taskRun.summaryText ?? ""}`,
      ].join("\n"),
      createdAt: existingSummary?.createdAt ?? session.createdAt,
      id: `memory-session-summary-${session.workerSessionId}`,
      noteType: "session_summary",
      projectId: session.projectId,
      taskRunId: session.taskRunId,
      title: `Codex task session snapshot`,
      updatedAt: timestamp,
    };

    upsertMemoryNote(this.context, note);
  }
}

function getAllProjectIds(context: IStorageContext): string[] {
  return listProjects(context).map((project) => project.id);
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

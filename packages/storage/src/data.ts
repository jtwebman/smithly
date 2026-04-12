import type {
  IApprovalRecord,
  IBacklogItemRecord,
  IBlockerRecord,
  IChatMessageRecord,
  IChatThreadRecord,
  IContext,
  IMemoryNoteRecord,
  IProjectRecord,
  IReviewRunRecord,
  ITaskRunRecord,
  IVerificationRunRecord,
  IWorkerSessionRecord,
} from "@smithly/core";

export function listProjects(context: IContext): IProjectRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        name,
        repo_path AS repoPath,
        status,
        default_branch AS defaultBranch,
        metadata_json AS metadataJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM projects
      ORDER BY created_at ASC, id ASC
    `,
    undefined,
    mapProject,
  );
}

export function getProjectById(context: IContext, projectId: string): IProjectRecord | null {
  return context.db.one(
    `
      SELECT
        id,
        name,
        repo_path AS repoPath,
        status,
        default_branch AS defaultBranch,
        metadata_json AS metadataJson,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM projects
      WHERE id = ?
    `,
    [projectId],
    mapProject,
  );
}

export function upsertProject(context: IContext, project: IProjectRecord): void {
  context.db.run(
    `
      INSERT INTO projects (
        id,
        name,
        repo_path,
        status,
        default_branch,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        repo_path = excluded.repo_path,
        status = excluded.status,
        default_branch = excluded.default_branch,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
    [
      project.id,
      project.name,
      project.repoPath,
      project.status,
      project.defaultBranch ?? null,
      project.metadataJson,
      project.createdAt,
      project.updatedAt,
    ],
  );
}

export function listBacklogItemsForProject(
  context: IContext,
  projectId: string,
): IBacklogItemRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        project_id AS projectId,
        parent_backlog_item_id AS parentBacklogItemId,
        title,
        status,
        readiness,
        priority,
        scope_summary AS scopeSummary,
        acceptance_criteria_json AS acceptanceCriteriaJson,
        risk_level AS riskLevel,
        review_mode AS reviewMode,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM backlog_items
      WHERE project_id = ?
      ORDER BY priority DESC, created_at ASC, id ASC
    `,
    [projectId],
    mapBacklogItem,
  );
}

export function getBacklogItemById(
  context: IContext,
  backlogItemId: string,
): IBacklogItemRecord | null {
  return context.db.one(
    `
      SELECT
        id,
        project_id AS projectId,
        parent_backlog_item_id AS parentBacklogItemId,
        title,
        status,
        readiness,
        priority,
        scope_summary AS scopeSummary,
        acceptance_criteria_json AS acceptanceCriteriaJson,
        risk_level AS riskLevel,
        review_mode AS reviewMode,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM backlog_items
      WHERE id = ?
    `,
    [backlogItemId],
    mapBacklogItem,
  );
}

export function upsertBacklogItem(context: IContext, backlogItem: IBacklogItemRecord): void {
  context.db.run(
    `
      INSERT INTO backlog_items (
        id,
        project_id,
        parent_backlog_item_id,
        title,
        status,
        readiness,
        priority,
        scope_summary,
        acceptance_criteria_json,
        risk_level,
        review_mode,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        parent_backlog_item_id = excluded.parent_backlog_item_id,
        title = excluded.title,
        status = excluded.status,
        readiness = excluded.readiness,
        priority = excluded.priority,
        scope_summary = excluded.scope_summary,
        acceptance_criteria_json = excluded.acceptance_criteria_json,
        risk_level = excluded.risk_level,
        review_mode = excluded.review_mode,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
    [
      backlogItem.id,
      backlogItem.projectId,
      backlogItem.parentBacklogItemId ?? null,
      backlogItem.title,
      backlogItem.status,
      backlogItem.readiness,
      backlogItem.priority,
      backlogItem.scopeSummary ?? null,
      backlogItem.acceptanceCriteriaJson,
      backlogItem.riskLevel,
      backlogItem.reviewMode,
      backlogItem.createdAt,
      backlogItem.updatedAt,
    ],
  );
}

export function listWorkerSessionsForProject(
  context: IContext,
  projectId: string,
): IWorkerSessionRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        project_id AS projectId,
        worker_kind AS workerKind,
        status,
        terminal_key AS terminalKey,
        transcript_ref AS transcriptRef,
        started_at AS startedAt,
        ended_at AS endedAt,
        last_heartbeat_at AS lastHeartbeatAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM worker_sessions
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [projectId],
    mapWorkerSession,
  );
}

export function upsertWorkerSession(context: IContext, session: IWorkerSessionRecord): void {
  context.db.run(
    `
      INSERT INTO worker_sessions (
        id,
        project_id,
        worker_kind,
        status,
        terminal_key,
        transcript_ref,
        started_at,
        ended_at,
        last_heartbeat_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        worker_kind = excluded.worker_kind,
        status = excluded.status,
        terminal_key = excluded.terminal_key,
        transcript_ref = excluded.transcript_ref,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
    [
      session.id,
      session.projectId,
      session.workerKind,
      session.status,
      session.terminalKey ?? null,
      session.transcriptRef ?? null,
      session.startedAt ?? null,
      session.endedAt ?? null,
      session.lastHeartbeatAt ?? null,
      session.createdAt,
      session.updatedAt,
    ],
  );
}

export function listTaskRunsForProject(context: IContext, projectId: string): ITaskRunRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        project_id AS projectId,
        backlog_item_id AS backlogItemId,
        worker_session_id AS workerSessionId,
        assigned_worker AS assignedWorker,
        status,
        summary_text AS summaryText,
        created_at AS createdAt,
        updated_at AS updatedAt,
        started_at AS startedAt,
        completed_at AS completedAt
      FROM task_runs
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [projectId],
    mapTaskRun,
  );
}

export function upsertTaskRun(context: IContext, taskRun: ITaskRunRecord): void {
  context.db.run(
    `
      INSERT INTO task_runs (
        id,
        project_id,
        backlog_item_id,
        worker_session_id,
        assigned_worker,
        status,
        summary_text,
        created_at,
        updated_at,
        started_at,
        completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        backlog_item_id = excluded.backlog_item_id,
        worker_session_id = excluded.worker_session_id,
        assigned_worker = excluded.assigned_worker,
        status = excluded.status,
        summary_text = excluded.summary_text,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `,
    [
      taskRun.id,
      taskRun.projectId,
      taskRun.backlogItemId,
      taskRun.workerSessionId ?? null,
      taskRun.assignedWorker,
      taskRun.status,
      taskRun.summaryText ?? null,
      taskRun.createdAt,
      taskRun.updatedAt,
      taskRun.startedAt ?? null,
      taskRun.completedAt ?? null,
    ],
  );
}

export function listBlockersForProject(context: IContext, projectId: string): IBlockerRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        project_id AS projectId,
        backlog_item_id AS backlogItemId,
        task_run_id AS taskRunId,
        blocker_type AS blockerType,
        status,
        title,
        detail,
        resolution_note AS resolutionNote,
        created_at AS createdAt,
        updated_at AS updatedAt,
        resolved_at AS resolvedAt
      FROM blockers
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [projectId],
    mapBlocker,
  );
}

export function upsertBlocker(context: IContext, blocker: IBlockerRecord): void {
  context.db.run(
    `
      INSERT INTO blockers (
        id,
        project_id,
        backlog_item_id,
        task_run_id,
        blocker_type,
        status,
        title,
        detail,
        resolution_note,
        created_at,
        updated_at,
        resolved_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        backlog_item_id = excluded.backlog_item_id,
        task_run_id = excluded.task_run_id,
        blocker_type = excluded.blocker_type,
        status = excluded.status,
        title = excluded.title,
        detail = excluded.detail,
        resolution_note = excluded.resolution_note,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at
    `,
    [
      blocker.id,
      blocker.projectId,
      blocker.backlogItemId ?? null,
      blocker.taskRunId ?? null,
      blocker.blockerType,
      blocker.status,
      blocker.title,
      blocker.detail,
      blocker.resolutionNote ?? null,
      blocker.createdAt,
      blocker.updatedAt,
      blocker.resolvedAt ?? null,
    ],
  );
}

export function listApprovalsForProject(context: IContext, projectId: string): IApprovalRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        project_id AS projectId,
        backlog_item_id AS backlogItemId,
        task_run_id AS taskRunId,
        requested_by AS requestedBy,
        decision_by AS decisionBy,
        status,
        title,
        detail,
        created_at AS createdAt,
        updated_at AS updatedAt,
        decided_at AS decidedAt
      FROM approvals
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [projectId],
    mapApproval,
  );
}

export function upsertApproval(context: IContext, approval: IApprovalRecord): void {
  context.db.run(
    `
      INSERT INTO approvals (
        id,
        project_id,
        backlog_item_id,
        task_run_id,
        requested_by,
        decision_by,
        status,
        title,
        detail,
        created_at,
        updated_at,
        decided_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        backlog_item_id = excluded.backlog_item_id,
        task_run_id = excluded.task_run_id,
        requested_by = excluded.requested_by,
        decision_by = excluded.decision_by,
        status = excluded.status,
        title = excluded.title,
        detail = excluded.detail,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        decided_at = excluded.decided_at
    `,
    [
      approval.id,
      approval.projectId,
      approval.backlogItemId ?? null,
      approval.taskRunId ?? null,
      approval.requestedBy,
      approval.decisionBy ?? null,
      approval.status,
      approval.title,
      approval.detail,
      approval.createdAt,
      approval.updatedAt,
      approval.decidedAt ?? null,
    ],
  );
}

export function listChatThreadsForProject(
  context: IContext,
  projectId: string,
): IChatThreadRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        project_id AS projectId,
        backlog_item_id AS backlogItemId,
        title,
        kind,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM chat_threads
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [projectId],
    mapChatThread,
  );
}

export function getChatThreadById(context: IContext, threadId: string): IChatThreadRecord | null {
  return context.db.one(
    `
      SELECT
        id,
        project_id AS projectId,
        backlog_item_id AS backlogItemId,
        title,
        kind,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM chat_threads
      WHERE id = ?
    `,
    [threadId],
    mapChatThread,
  );
}

export function upsertChatThread(context: IContext, thread: IChatThreadRecord): void {
  context.db.run(
    `
      INSERT INTO chat_threads (
        id,
        project_id,
        backlog_item_id,
        title,
        kind,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        backlog_item_id = excluded.backlog_item_id,
        title = excluded.title,
        kind = excluded.kind,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
    [
      thread.id,
      thread.projectId,
      thread.backlogItemId ?? null,
      thread.title,
      thread.kind,
      thread.status,
      thread.createdAt,
      thread.updatedAt,
    ],
  );
}

export function listChatMessagesForThread(
  context: IContext,
  threadId: string,
): IChatMessageRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        thread_id AS threadId,
        role,
        body_text AS bodyText,
        metadata_json AS metadataJson,
        created_at AS createdAt
      FROM chat_messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [threadId],
    mapChatMessage,
  );
}

export function deleteChatMessagesForThread(context: IContext, threadId: string): boolean {
  return context.db.run("DELETE FROM chat_messages WHERE thread_id = ?", [threadId]).changes > 0;
}

export function upsertChatMessage(context: IContext, message: IChatMessageRecord): void {
  context.db.run(
    `
      INSERT INTO chat_messages (
        id,
        thread_id,
        role,
        body_text,
        metadata_json,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        thread_id = excluded.thread_id,
        role = excluded.role,
        body_text = excluded.body_text,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at
    `,
    [
      message.id,
      message.threadId,
      message.role,
      message.bodyText,
      message.metadataJson,
      message.createdAt,
    ],
  );
}

export function listMemoryNotesForProject(
  context: IContext,
  projectId: string,
): IMemoryNoteRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        project_id AS projectId,
        backlog_item_id AS backlogItemId,
        task_run_id AS taskRunId,
        source_thread_id AS sourceThreadId,
        note_type AS noteType,
        title,
        body_text AS bodyText,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM memory_notes
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [projectId],
    mapMemoryNote,
  );
}

export function upsertMemoryNote(context: IContext, note: IMemoryNoteRecord): void {
  context.db.run(
    `
      INSERT INTO memory_notes (
        id,
        project_id,
        backlog_item_id,
        task_run_id,
        source_thread_id,
        note_type,
        title,
        body_text,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        backlog_item_id = excluded.backlog_item_id,
        task_run_id = excluded.task_run_id,
        source_thread_id = excluded.source_thread_id,
        note_type = excluded.note_type,
        title = excluded.title,
        body_text = excluded.body_text,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
    [
      note.id,
      note.projectId,
      note.backlogItemId ?? null,
      note.taskRunId ?? null,
      note.sourceThreadId ?? null,
      note.noteType,
      note.title,
      note.bodyText,
      note.createdAt,
      note.updatedAt,
    ],
  );
}

export function listVerificationRunsForTask(
  context: IContext,
  taskRunId: string,
): IVerificationRunRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        project_id AS projectId,
        task_run_id AS taskRunId,
        status,
        command_text AS commandText,
        summary_text AS summaryText,
        artifact_path AS artifactPath,
        created_at AS createdAt,
        updated_at AS updatedAt,
        started_at AS startedAt,
        completed_at AS completedAt
      FROM verification_runs
      WHERE task_run_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [taskRunId],
    mapVerificationRun,
  );
}

export function upsertVerificationRun(
  context: IContext,
  verificationRun: IVerificationRunRecord,
): void {
  context.db.run(
    `
      INSERT INTO verification_runs (
        id,
        project_id,
        task_run_id,
        status,
        command_text,
        summary_text,
        artifact_path,
        created_at,
        updated_at,
        started_at,
        completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        task_run_id = excluded.task_run_id,
        status = excluded.status,
        command_text = excluded.command_text,
        summary_text = excluded.summary_text,
        artifact_path = excluded.artifact_path,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `,
    [
      verificationRun.id,
      verificationRun.projectId,
      verificationRun.taskRunId,
      verificationRun.status,
      verificationRun.commandText,
      verificationRun.summaryText ?? null,
      verificationRun.artifactPath ?? null,
      verificationRun.createdAt,
      verificationRun.updatedAt,
      verificationRun.startedAt ?? null,
      verificationRun.completedAt ?? null,
    ],
  );
}

export function listReviewRunsForTask(context: IContext, taskRunId: string): IReviewRunRecord[] {
  return context.db.many(
    `
      SELECT
        id,
        project_id AS projectId,
        task_run_id AS taskRunId,
        reviewer_kind AS reviewerKind,
        status,
        summary_text AS summaryText,
        created_at AS createdAt,
        updated_at AS updatedAt,
        completed_at AS completedAt
      FROM review_runs
      WHERE task_run_id = ?
      ORDER BY created_at ASC, id ASC
    `,
    [taskRunId],
    mapReviewRun,
  );
}

export function upsertReviewRun(context: IContext, reviewRun: IReviewRunRecord): void {
  context.db.run(
    `
      INSERT INTO review_runs (
        id,
        project_id,
        task_run_id,
        reviewer_kind,
        status,
        summary_text,
        created_at,
        updated_at,
        completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id,
        task_run_id = excluded.task_run_id,
        reviewer_kind = excluded.reviewer_kind,
        status = excluded.status,
        summary_text = excluded.summary_text,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `,
    [
      reviewRun.id,
      reviewRun.projectId,
      reviewRun.taskRunId,
      reviewRun.reviewerKind,
      reviewRun.status,
      reviewRun.summaryText ?? null,
      reviewRun.createdAt,
      reviewRun.updatedAt,
      reviewRun.completedAt ?? null,
    ],
  );
}

export function deleteProjectById(context: IContext, projectId: string): boolean {
  return context.db.run("DELETE FROM projects WHERE id = ?", [projectId]).changes > 0;
}

function mapProject(row: Record<string, unknown>): IProjectRecord {
  return {
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    id: stringFromRow(row.id, "id"),
    metadataJson: stringFromRow(row.metadataJson, "metadataJson"),
    name: stringFromRow(row.name, "name"),
    repoPath: stringFromRow(row.repoPath, "repoPath"),
    status: stringFromRow(row.status, "status") as IProjectRecord["status"],
    updatedAt: stringFromRow(row.updatedAt, "updatedAt"),
    ...(typeof row.defaultBranch === "string" ? { defaultBranch: row.defaultBranch } : {}),
  };
}

function mapBacklogItem(row: Record<string, unknown>): IBacklogItemRecord {
  return {
    acceptanceCriteriaJson: stringFromRow(row.acceptanceCriteriaJson, "acceptanceCriteriaJson"),
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    id: stringFromRow(row.id, "id"),
    priority: numberFromRow(row.priority, "priority"),
    projectId: stringFromRow(row.projectId, "projectId"),
    readiness: stringFromRow(row.readiness, "readiness") as IBacklogItemRecord["readiness"],
    reviewMode: stringFromRow(row.reviewMode, "reviewMode") as IBacklogItemRecord["reviewMode"],
    riskLevel: stringFromRow(row.riskLevel, "riskLevel") as IBacklogItemRecord["riskLevel"],
    status: stringFromRow(row.status, "status") as IBacklogItemRecord["status"],
    title: stringFromRow(row.title, "title"),
    updatedAt: stringFromRow(row.updatedAt, "updatedAt"),
    ...(typeof row.parentBacklogItemId === "string"
      ? { parentBacklogItemId: row.parentBacklogItemId }
      : {}),
    ...(typeof row.scopeSummary === "string" ? { scopeSummary: row.scopeSummary } : {}),
  };
}

function mapWorkerSession(row: Record<string, unknown>): IWorkerSessionRecord {
  return {
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    id: stringFromRow(row.id, "id"),
    projectId: stringFromRow(row.projectId, "projectId"),
    status: stringFromRow(row.status, "status") as IWorkerSessionRecord["status"],
    updatedAt: stringFromRow(row.updatedAt, "updatedAt"),
    workerKind: stringFromRow(row.workerKind, "workerKind") as IWorkerSessionRecord["workerKind"],
    ...(typeof row.endedAt === "string" ? { endedAt: row.endedAt } : {}),
    ...(typeof row.lastHeartbeatAt === "string" ? { lastHeartbeatAt: row.lastHeartbeatAt } : {}),
    ...(typeof row.startedAt === "string" ? { startedAt: row.startedAt } : {}),
    ...(typeof row.terminalKey === "string" ? { terminalKey: row.terminalKey } : {}),
    ...(typeof row.transcriptRef === "string" ? { transcriptRef: row.transcriptRef } : {}),
  };
}

function mapTaskRun(row: Record<string, unknown>): ITaskRunRecord {
  return {
    assignedWorker: stringFromRow(
      row.assignedWorker,
      "assignedWorker",
    ) as ITaskRunRecord["assignedWorker"],
    backlogItemId: stringFromRow(row.backlogItemId, "backlogItemId"),
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    id: stringFromRow(row.id, "id"),
    projectId: stringFromRow(row.projectId, "projectId"),
    status: stringFromRow(row.status, "status") as ITaskRunRecord["status"],
    updatedAt: stringFromRow(row.updatedAt, "updatedAt"),
    ...(typeof row.completedAt === "string" ? { completedAt: row.completedAt } : {}),
    ...(typeof row.startedAt === "string" ? { startedAt: row.startedAt } : {}),
    ...(typeof row.summaryText === "string" ? { summaryText: row.summaryText } : {}),
    ...(typeof row.workerSessionId === "string" ? { workerSessionId: row.workerSessionId } : {}),
  };
}

function mapBlocker(row: Record<string, unknown>): IBlockerRecord {
  return {
    blockerType: stringFromRow(row.blockerType, "blockerType") as IBlockerRecord["blockerType"],
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    detail: stringFromRow(row.detail, "detail"),
    id: stringFromRow(row.id, "id"),
    projectId: stringFromRow(row.projectId, "projectId"),
    status: stringFromRow(row.status, "status") as IBlockerRecord["status"],
    title: stringFromRow(row.title, "title"),
    updatedAt: stringFromRow(row.updatedAt, "updatedAt"),
    ...(typeof row.backlogItemId === "string" ? { backlogItemId: row.backlogItemId } : {}),
    ...(typeof row.resolutionNote === "string" ? { resolutionNote: row.resolutionNote } : {}),
    ...(typeof row.resolvedAt === "string" ? { resolvedAt: row.resolvedAt } : {}),
    ...(typeof row.taskRunId === "string" ? { taskRunId: row.taskRunId } : {}),
  };
}

function mapApproval(row: Record<string, unknown>): IApprovalRecord {
  return {
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    detail: stringFromRow(row.detail, "detail"),
    id: stringFromRow(row.id, "id"),
    projectId: stringFromRow(row.projectId, "projectId"),
    requestedBy: stringFromRow(row.requestedBy, "requestedBy") as IApprovalRecord["requestedBy"],
    status: stringFromRow(row.status, "status") as IApprovalRecord["status"],
    title: stringFromRow(row.title, "title"),
    updatedAt: stringFromRow(row.updatedAt, "updatedAt"),
    ...(typeof row.backlogItemId === "string" ? { backlogItemId: row.backlogItemId } : {}),
    ...(typeof row.decidedAt === "string" ? { decidedAt: row.decidedAt } : {}),
    ...(typeof row.decisionBy === "string" ? { decisionBy: row.decisionBy } : {}),
    ...(typeof row.taskRunId === "string" ? { taskRunId: row.taskRunId } : {}),
  };
}

function mapChatThread(row: Record<string, unknown>): IChatThreadRecord {
  return {
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    id: stringFromRow(row.id, "id"),
    kind: stringFromRow(row.kind, "kind") as IChatThreadRecord["kind"],
    projectId: stringFromRow(row.projectId, "projectId"),
    status: stringFromRow(row.status, "status") as IChatThreadRecord["status"],
    title: stringFromRow(row.title, "title"),
    updatedAt: stringFromRow(row.updatedAt, "updatedAt"),
    ...(typeof row.backlogItemId === "string" ? { backlogItemId: row.backlogItemId } : {}),
  };
}

function mapChatMessage(row: Record<string, unknown>): IChatMessageRecord {
  return {
    bodyText: stringFromRow(row.bodyText, "bodyText"),
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    id: stringFromRow(row.id, "id"),
    metadataJson: stringFromRow(row.metadataJson, "metadataJson"),
    role: stringFromRow(row.role, "role") as IChatMessageRecord["role"],
    threadId: stringFromRow(row.threadId, "threadId"),
  };
}

function mapMemoryNote(row: Record<string, unknown>): IMemoryNoteRecord {
  return {
    bodyText: stringFromRow(row.bodyText, "bodyText"),
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    id: stringFromRow(row.id, "id"),
    noteType: stringFromRow(row.noteType, "noteType") as IMemoryNoteRecord["noteType"],
    projectId: stringFromRow(row.projectId, "projectId"),
    title: stringFromRow(row.title, "title"),
    updatedAt: stringFromRow(row.updatedAt, "updatedAt"),
    ...(typeof row.backlogItemId === "string" ? { backlogItemId: row.backlogItemId } : {}),
    ...(typeof row.sourceThreadId === "string" ? { sourceThreadId: row.sourceThreadId } : {}),
    ...(typeof row.taskRunId === "string" ? { taskRunId: row.taskRunId } : {}),
  };
}

function mapVerificationRun(row: Record<string, unknown>): IVerificationRunRecord {
  return {
    commandText: stringFromRow(row.commandText, "commandText"),
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    id: stringFromRow(row.id, "id"),
    projectId: stringFromRow(row.projectId, "projectId"),
    status: stringFromRow(row.status, "status") as IVerificationRunRecord["status"],
    taskRunId: stringFromRow(row.taskRunId, "taskRunId"),
    updatedAt: stringFromRow(row.updatedAt, "updatedAt"),
    ...(typeof row.artifactPath === "string" ? { artifactPath: row.artifactPath } : {}),
    ...(typeof row.completedAt === "string" ? { completedAt: row.completedAt } : {}),
    ...(typeof row.startedAt === "string" ? { startedAt: row.startedAt } : {}),
    ...(typeof row.summaryText === "string" ? { summaryText: row.summaryText } : {}),
  };
}

function mapReviewRun(row: Record<string, unknown>): IReviewRunRecord {
  return {
    createdAt: stringFromRow(row.createdAt, "createdAt"),
    id: stringFromRow(row.id, "id"),
    projectId: stringFromRow(row.projectId, "projectId"),
    reviewerKind: stringFromRow(
      row.reviewerKind,
      "reviewerKind",
    ) as IReviewRunRecord["reviewerKind"],
    status: stringFromRow(row.status, "status") as IReviewRunRecord["status"],
    taskRunId: stringFromRow(row.taskRunId, "taskRunId"),
    updatedAt: stringFromRow(row.updatedAt, "updatedAt"),
    ...(typeof row.completedAt === "string" ? { completedAt: row.completedAt } : {}),
    ...(typeof row.summaryText === "string" ? { summaryText: row.summaryText } : {}),
  };
}

function stringFromRow(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string field ${fieldName}`);
  }

  return value;
}

function numberFromRow(value: unknown, fieldName: string): number {
  if (typeof value !== "number") {
    throw new Error(`Expected number field ${fieldName}`);
  }

  return value;
}

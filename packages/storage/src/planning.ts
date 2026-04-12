import { randomUUID } from "node:crypto";

import type {
  IApprovalRecord,
  IBacklogItemRecord,
  IChatMessageRecord,
  IChatThreadRecord,
  IContext,
  IMemoryNoteRecord,
  ITaskRunRecord,
  IBlockerRecord,
  ReviewMode,
  RiskLevel,
  WorkerKind,
} from "@smithly/core";

import {
  getBacklogItemById,
  getProjectById,
  listBacklogItemsForProject,
  listBlockersForProject,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  listTaskRunsForProject,
  upsertApproval,
  upsertBacklogItem,
  upsertChatMessage,
  upsertChatThread,
  upsertMemoryNote,
  upsertTaskRun,
} from "./data.ts";
import { parseProjectMetadata, updateProjectMetadata } from "./projects.ts";

export interface ICreateDraftBacklogItemInput {
  readonly projectId: string;
  readonly sourceThreadId: string;
  readonly title: string;
  readonly scopeSummary: string;
}

export interface IReviseBacklogItemInput {
  readonly backlogItemId: string;
  readonly scopeSummary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly noteText?: string;
  readonly priority?: number;
  readonly readiness?: IBacklogItemRecord["readiness"];
  readonly reviewMode?: ReviewMode;
  readonly riskLevel?: RiskLevel;
  readonly sourceThreadId?: string;
  readonly status?: IBacklogItemRecord["status"];
}

export interface IStartCodingTaskInput {
  readonly backlogItemId: string;
  readonly assignedWorker?: WorkerKind;
  readonly initialStatus?: "queued" | "running";
  readonly summaryText?: string;
}

export interface IUpsertBootstrapMvpPlanInput {
  readonly bodyText: string;
  readonly projectId: string;
}

export interface ICreateBootstrapBacklogItemInput {
  readonly acceptanceCriteria?: readonly string[];
  readonly priority?: number;
  readonly projectId: string;
  readonly reviewMode?: ReviewMode;
  readonly riskLevel?: RiskLevel;
  readonly scopeSummary: string;
  readonly title: string;
}

export interface IApproveBootstrapBacklogItemInput {
  readonly backlogItemId: string;
  readonly detail?: string;
}

export interface IFinalizeBootstrapProjectInput {
  readonly projectId: string;
}

const BOOTSTRAP_MVP_PLAN_NOTE_ID_PREFIX = "memory-bootstrap-mvp-plan-";

export function createDraftBacklogItemFromPlanning(
  context: IContext,
  input: ICreateDraftBacklogItemInput,
): IBacklogItemRecord {
  const sourceThread = requireThreadById(context, input.projectId, input.sourceThreadId);

  if (sourceThread.kind !== "project_planning") {
    throw new Error("Draft backlog items can only be created from a project planning thread.");
  }

  const timestamp = new Date().toISOString();
  const backlogItemId = `backlog-${randomUUID()}`;
  const taskThreadId = `thread-task-${randomUUID()}`;
  const backlogItem: IBacklogItemRecord = {
    acceptanceCriteriaJson: "[]",
    createdAt: timestamp,
    id: backlogItemId,
    priority: 10,
    projectId: input.projectId,
    readiness: "not_ready",
    reviewMode: "human",
    riskLevel: "low",
    scopeSummary: input.scopeSummary,
    status: "draft",
    title: input.title,
    updatedAt: timestamp,
  };

  upsertBacklogItem(context, backlogItem);
  upsertChatThread(context, {
    backlogItemId,
    createdAt: timestamp,
    id: taskThreadId,
    kind: "task_planning",
    projectId: input.projectId,
    status: "open",
    title: `${input.title} planning`,
    updatedAt: timestamp,
  });
  upsertChatMessage(
    context,
    createMessage(
      sourceThread.id,
      "tool",
      `Created draft backlog item "${input.title}" with scope: ${input.scopeSummary}`,
      timestamp,
    ),
  );
  upsertChatMessage(
    context,
    createMessage(
      taskThreadId,
      "system",
      "Refine scope and acceptance criteria before requesting approval.",
      timestamp,
    ),
  );
  upsertChatThread(context, {
    ...sourceThread,
    updatedAt: timestamp,
  });

  return backlogItem;
}

export function reviseBacklogItemFromPlanning(
  context: IContext,
  input: IReviseBacklogItemInput,
): IBacklogItemRecord {
  const backlogItem = requireBacklogItem(context, input.backlogItemId);
  const timestamp = new Date().toISOString();
  const normalizedAcceptanceCriteria = input.acceptanceCriteria
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0);
  const revisedBacklogItem: IBacklogItemRecord = {
    ...backlogItem,
    acceptanceCriteriaJson: JSON.stringify(normalizedAcceptanceCriteria),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.readiness !== undefined ? { readiness: input.readiness } : {}),
    ...(input.reviewMode !== undefined ? { reviewMode: input.reviewMode } : {}),
    ...(input.riskLevel !== undefined ? { riskLevel: input.riskLevel } : {}),
    scopeSummary: input.scopeSummary,
    ...(input.status !== undefined ? { status: input.status } : {}),
    updatedAt: timestamp,
  };

  upsertBacklogItem(context, revisedBacklogItem);

  if (input.sourceThreadId !== undefined) {
    const sourceThread = requireThreadById(context, backlogItem.projectId, input.sourceThreadId);

    upsertChatMessage(
      context,
      createMessage(
        sourceThread.id,
        "tool",
        `Updated backlog item "${backlogItem.title}" with ${normalizedAcceptanceCriteria.length} acceptance criteria and status ${revisedBacklogItem.status}.`,
        timestamp,
      ),
    );

    if (input.noteText?.trim()) {
      upsertChatMessage(
        context,
        createMessage(sourceThread.id, "human", input.noteText.trim(), timestamp),
      );
    }

    upsertChatThread(context, {
      ...sourceThread,
      updatedAt: timestamp,
    });
  }

  return revisedBacklogItem;
}

export function startCodingTask(context: IContext, input: IStartCodingTaskInput): ITaskRunRecord {
  const backlogItem = requireBacklogItem(context, input.backlogItemId);
  const assignedWorker = input.assignedWorker ?? "codex";
  const existingTaskRun = listTaskRunsForProject(context, backlogItem.projectId).find((taskRun) => {
    return (
      taskRun.backlogItemId === backlogItem.id &&
      taskRun.assignedWorker === assignedWorker &&
      ["queued", "running", "blocked", "awaiting_review"].includes(taskRun.status)
    );
  });

  if (existingTaskRun !== undefined) {
    return existingTaskRun;
  }

  assertBacklogItemReadyForExecution(context, backlogItem);

  const timestamp = new Date().toISOString();
  const initialStatus = input.initialStatus ?? "queued";
  const taskRun: ITaskRunRecord = {
    assignedWorker,
    backlogItemId: backlogItem.id,
    createdAt: timestamp,
    id: `taskrun-${randomUUID()}`,
    projectId: backlogItem.projectId,
    ...(initialStatus === "running" ? { startedAt: timestamp } : {}),
    ...(input.summaryText?.trim()
      ? { summaryText: input.summaryText.trim() }
      : { summaryText: `Start ${assignedWorker} work for ${backlogItem.title}.` }),
    status: initialStatus,
    updatedAt: timestamp,
  };

  upsertBacklogItem(context, {
    ...backlogItem,
    status: "in_progress",
    updatedAt: timestamp,
  });
  upsertTaskRun(context, taskRun);

  return taskRun;
}

export function ensureProjectPlanningThread(
  context: IContext,
  projectId: string,
): IChatThreadRecord {
  requireProject(projectId, context);
  const existingThread = listChatThreadsForProject(context, projectId).find((thread) => {
    return thread.kind === "project_planning";
  });

  if (existingThread !== undefined) {
    return existingThread;
  }

  const timestamp = new Date().toISOString();
  const planningThread: IChatThreadRecord = {
    createdAt: timestamp,
    id: `thread-project-${randomUUID()}`,
    kind: "project_planning",
    projectId,
    status: "open",
    title: "Project planning",
    updatedAt: timestamp,
  };

  upsertChatThread(context, planningThread);
  upsertChatMessage(
    context,
    createMessage(
      planningThread.id,
      "system",
      "Bootstrap planning thread created for MVP shaping and initial backlog approval.",
      timestamp,
    ),
  );

  return planningThread;
}

export function getBootstrapMvpPlan(
  context: IContext,
  projectId: string,
): IMemoryNoteRecord | null {
  requireProject(projectId, context);

  return (
    listMemoryNotesForProject(context, projectId).find((note) => {
      return note.id === `${BOOTSTRAP_MVP_PLAN_NOTE_ID_PREFIX}${projectId}`;
    }) ?? null
  );
}

export function upsertBootstrapMvpPlan(
  context: IContext,
  input: IUpsertBootstrapMvpPlanInput,
): IMemoryNoteRecord {
  const planningThread = ensureProjectPlanningThread(context, input.projectId);
  const existingNote = getBootstrapMvpPlan(context, input.projectId);
  const timestamp = new Date().toISOString();
  const bodyText = input.bodyText.trim();

  if (bodyText.length === 0) {
    throw new Error("Bootstrap MVP plan text is required.");
  }

  const planNote: IMemoryNoteRecord = {
    bodyText,
    createdAt: existingNote?.createdAt ?? timestamp,
    id: `${BOOTSTRAP_MVP_PLAN_NOTE_ID_PREFIX}${input.projectId}`,
    noteType: "note",
    projectId: input.projectId,
    sourceThreadId: planningThread.id,
    title: "Bootstrap MVP plan",
    updatedAt: timestamp,
  };

  upsertMemoryNote(context, planNote);
  upsertChatMessage(
    context,
    createMessage(
      planningThread.id,
      "tool",
      "Updated the bootstrap MVP plan for this project.",
      timestamp,
    ),
  );
  upsertChatThread(context, {
    ...planningThread,
    updatedAt: timestamp,
  });

  return planNote;
}

export function createBootstrapBacklogItem(
  context: IContext,
  input: ICreateBootstrapBacklogItemInput,
): IBacklogItemRecord {
  const planningThread = ensureProjectPlanningThread(context, input.projectId);
  const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
    projectId: input.projectId,
    scopeSummary: input.scopeSummary,
    sourceThreadId: planningThread.id,
    title: input.title,
  });
  const hasRevisions =
    (input.acceptanceCriteria?.length ?? 0) > 0 ||
    input.priority !== undefined ||
    input.reviewMode !== undefined ||
    input.riskLevel !== undefined;

  if (!hasRevisions) {
    return createdBacklogItem;
  }

  return reviseBacklogItemFromPlanning(context, {
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    backlogItemId: createdBacklogItem.id,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.reviewMode !== undefined ? { reviewMode: input.reviewMode } : {}),
    ...(input.riskLevel !== undefined ? { riskLevel: input.riskLevel } : {}),
    scopeSummary: input.scopeSummary,
    sourceThreadId: planningThread.id,
    status: "draft",
  });
}

export function approveBootstrapBacklogItem(
  context: IContext,
  input: IApproveBootstrapBacklogItemInput,
): {
  readonly approval: IApprovalRecord;
  readonly backlogItem: IBacklogItemRecord;
} {
  const backlogItem = requireBacklogItem(context, input.backlogItemId);
  const planningThread = ensureProjectPlanningThread(context, backlogItem.projectId);
  const timestamp = new Date().toISOString();
  const approvedBacklogItem: IBacklogItemRecord = {
    ...backlogItem,
    readiness: "ready",
    status: "approved",
    updatedAt: timestamp,
  };
  const approval: IApprovalRecord = {
    backlogItemId: backlogItem.id,
    createdAt: timestamp,
    decisionBy: "human",
    decidedAt: timestamp,
    detail: input.detail?.trim() || `Approved during bootstrap planning for ${backlogItem.title}.`,
    id: `approval-${randomUUID()}`,
    projectId: backlogItem.projectId,
    requestedBy: "human",
    status: "approved",
    title: `Approve bootstrap backlog item: ${backlogItem.title}`,
    updatedAt: timestamp,
  };

  upsertBacklogItem(context, approvedBacklogItem);
  upsertApproval(context, approval);
  upsertChatMessage(
    context,
    createMessage(
      planningThread.id,
      "tool",
      `Approved bootstrap backlog item "${backlogItem.title}".`,
      timestamp,
    ),
  );
  upsertChatThread(context, {
    ...planningThread,
    updatedAt: timestamp,
  });

  return {
    approval,
    backlogItem: approvedBacklogItem,
  };
}

export function finalizeBootstrapProject(context: IContext, input: IFinalizeBootstrapProjectInput) {
  const project = requireProject(input.projectId, context);
  const bootstrapPlan = getBootstrapMvpPlan(context, input.projectId);

  if (bootstrapPlan === null) {
    throw new Error("Bootstrap MVP plan is required before finalizing the project.");
  }

  const approvedBootstrapBacklogItems = requireApprovedBootstrapBacklogItems(
    context,
    input.projectId,
  );
  const metadata = parseProjectMetadata(project);

  return updateProjectMetadata(context, {
    metadata: {
      ...metadata.metadata,
      bootstrapApprovedBacklogCount: String(approvedBootstrapBacklogItems.length),
      bootstrapCompletedAt: new Date().toISOString(),
      bootstrapState: "ready_for_dashboard",
    },
    projectId: input.projectId,
  });
}

function requireBacklogItem(context: IContext, backlogItemId: string): IBacklogItemRecord {
  const backlogItem = getBacklogItemById(context, backlogItemId);

  if (backlogItem === null) {
    throw new Error(`Missing backlog item ${backlogItemId}`);
  }

  return backlogItem;
}

function requireProject(projectId: string, context: IContext) {
  const project = getProjectById(context, projectId);

  if (project === null) {
    throw new Error(`Missing project ${projectId}`);
  }

  return project;
}

function requireThreadById(
  context: IContext,
  projectId: string,
  threadId: string,
): IChatThreadRecord {
  const thread = listChatThreadsForProject(context, projectId).find(
    (candidate) => candidate.id === threadId,
  );

  if (thread === undefined) {
    throw new Error(`Missing planning thread ${threadId}`);
  }

  return thread;
}

function createMessage(
  threadId: string,
  role: IChatMessageRecord["role"],
  bodyText: string,
  createdAt: string,
): IChatMessageRecord {
  return {
    bodyText,
    createdAt,
    id: `message-${randomUUID()}`,
    metadataJson: "{}",
    role,
    threadId,
  };
}

function requireApprovedBootstrapBacklogItems(context: IContext, projectId: string) {
  const projectBacklogItems = listBacklogItemsForProject(context, projectId).filter(
    (backlogItem) => {
      return backlogItem.status === "approved";
    },
  );

  if (projectBacklogItems.length === 0) {
    throw new Error("Approve at least one bootstrap backlog item before finalizing the project.");
  }

  return projectBacklogItems;
}

function assertBacklogItemReadyForExecution(
  context: IContext,
  backlogItem: IBacklogItemRecord,
): void {
  const blockingReasons: string[] = [];

  if (backlogItem.status !== "approved") {
    blockingReasons.push(`status is ${backlogItem.status}`);
  }

  if (backlogItem.readiness !== "ready") {
    blockingReasons.push(`readiness is ${backlogItem.readiness}`);
  }

  const openBlockers = listExecutionBlockers(context, backlogItem);

  if (openBlockers.length > 0) {
    blockingReasons.push(
      `${openBlockers.length} open blocker${openBlockers.length === 1 ? "" : "s"} must be cleared`,
    );
  }

  if (blockingReasons.length > 0) {
    throw new Error(
      `Backlog item ${backlogItem.id} cannot start execution until ${blockingReasons.join(", ")}.`,
    );
  }
}

function listExecutionBlockers(
  context: IContext,
  backlogItem: IBacklogItemRecord,
): IBlockerRecord[] {
  return listBlockersForProject(context, backlogItem.projectId).filter((blocker) => {
    if (blocker.status !== "open") {
      return false;
    }

    if (blocker.taskRunId !== undefined) {
      return false;
    }

    return blocker.backlogItemId === undefined || blocker.backlogItemId === backlogItem.id;
  });
}

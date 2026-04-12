import { randomUUID } from "node:crypto";

import type {
  IApprovalRecord,
  IBacklogItemRecord,
  IBacklogDependencyRecord,
  IBlockerRecord,
  IChatMessageRecord,
  IChatThreadRecord,
  IContext,
  IMemoryNoteRecord,
  ITaskRunRecord,
  ReviewMode,
  RiskLevel,
  WorkerKind,
} from "@smithly/core";

import {
  deleteBacklogDependencyLink,
  getBacklogItemById,
  getProjectById,
  listBacklogDependencyLinksForProject,
  listBacklogItemsForProject,
  listBlockersForProject,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  listTaskRunsForProject,
  upsertApproval,
  upsertBacklogItem,
  upsertBacklogDependencyLink,
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

export interface IRemovePendingBacklogItemInput {
  readonly backlogItemId: string;
  readonly noteText?: string;
  readonly sourceThreadId?: string;
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

export interface IReprioritizeBacklogItemInput {
  readonly backlogItemId: string;
  readonly priority: number;
  readonly noteText?: string;
  readonly sourceThreadId?: string;
}

export interface IReorderPendingBacklogItemsInput {
  readonly projectId: string;
  readonly backlogItemIds: readonly string[];
  readonly noteText?: string;
  readonly sourceThreadId?: string;
}

export interface IAddBacklogDependencyInput {
  readonly blockingBacklogItemId: string;
  readonly blockedBacklogItemId: string;
  readonly noteText?: string;
  readonly sourceThreadId?: string;
}

export interface IRemoveBacklogDependencyInput {
  readonly blockingBacklogItemId: string;
  readonly blockedBacklogItemId: string;
  readonly noteText?: string;
  readonly sourceThreadId?: string;
}

export interface IBacklogSplitDraftInput {
  readonly title: string;
  readonly scopeSummary: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly priority?: number;
  readonly readiness?: IBacklogItemRecord["readiness"];
  readonly reviewMode?: ReviewMode;
  readonly riskLevel?: RiskLevel;
  readonly status?: Extract<IBacklogItemRecord["status"], "approved" | "draft">;
}

export interface ISplitBacklogItemInput {
  readonly backlogItemId: string;
  readonly splitItems: readonly IBacklogSplitDraftInput[];
  readonly noteText?: string;
  readonly sourceThreadId?: string;
}

export interface IMergeDuplicateBacklogItemsInput {
  readonly targetBacklogItemId: string;
  readonly duplicateBacklogItemIds: readonly string[];
  readonly noteText?: string;
  readonly sourceThreadId?: string;
}

export interface IMarkBacklogItemStaleInput {
  readonly backlogItemId: string;
  readonly noteText?: string;
  readonly sourceThreadId?: string;
}

export interface IExplainBacklogPriorityInput {
  readonly backlogItemId: string;
}

export interface IBacklogPriorityExplanation {
  readonly backlogItemId: string;
  readonly isNext: boolean;
  readonly readyForExecution: boolean;
  readonly activeTaskRunId: string | null;
  readonly blockingReasons: readonly string[];
  readonly higherPriorityRunnableBacklogItemIds: readonly string[];
  readonly explanation: string;
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
const ACTIVE_TASK_RUN_STATUSES = new Set<ITaskRunRecord["status"]>([
  "queued",
  "running",
  "blocked",
  "awaiting_review",
]);
const PLANNING_REORDERABLE_BACKLOG_STATUSES = new Set<IBacklogItemRecord["status"]>([
  "draft",
  "approved",
  "blocked",
]);

export function createDraftBacklogItemFromPlanning(
  context: IContext,
  input: ICreateDraftBacklogItemInput,
): IBacklogItemRecord {
  const sourceThread = requireThreadById(context, input.projectId, input.sourceThreadId);

  if (!["project_planning", "task_planning"].includes(sourceThread.kind)) {
    throw new Error(
      "Draft backlog items can only be created from a project or task planning thread.",
    );
  }

  const timestamp = new Date().toISOString();
  const backlogItem = createPlanningBacklogItem(context, {
    projectId: input.projectId,
    scopeSummary: input.scopeSummary,
    title: input.title,
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
  upsertChatThread(context, {
    ...sourceThread,
    updatedAt: timestamp,
  });

  return backlogItem;
}

export function splitBacklogItemFromPlanning(
  context: IContext,
  input: ISplitBacklogItemInput,
): {
  readonly originalBacklogItem: IBacklogItemRecord;
  readonly splitBacklogItems: readonly IBacklogItemRecord[];
} {
  if (input.splitItems.length < 2) {
    throw new Error("Split at least one oversized task into two or more backlog items.");
  }

  const backlogItem = requirePendingPlanningBacklogItem(context, input.backlogItemId, "split");
  const timestamp = new Date().toISOString();
  const splitBacklogItems = input.splitItems.map((splitItem) => {
    return createPlanningBacklogItem(context, {
      acceptanceCriteria: splitItem.acceptanceCriteria ?? [],
      priority: splitItem.priority ?? backlogItem.priority,
      projectId: backlogItem.projectId,
      readiness: splitItem.readiness ?? "not_ready",
      reviewMode: splitItem.reviewMode ?? backlogItem.reviewMode,
      riskLevel: splitItem.riskLevel ?? backlogItem.riskLevel,
      scopeSummary: splitItem.scopeSummary,
      status: splitItem.status ?? "draft",
      title: splitItem.title,
    });
  });
  const cancelledBacklogItem: IBacklogItemRecord = {
    ...backlogItem,
    status: "cancelled",
    updatedAt: timestamp,
  };

  upsertBacklogItem(context, cancelledBacklogItem);
  rewireBacklogDependenciesAfterReplacement(context, backlogItem.id, splitBacklogItems[0]?.id);
  recordPlanningMutation(
    context,
    backlogItem.projectId,
    input.sourceThreadId,
    `Split oversized backlog item "${backlogItem.title}" into ${splitBacklogItems
      .map((splitItem) => `"${splitItem.title}"`)
      .join(", ")}.`,
    input.noteText,
    timestamp,
  );

  return {
    originalBacklogItem: cancelledBacklogItem,
    splitBacklogItems,
  };
}

export function mergeDuplicateBacklogItemsFromPlanning(
  context: IContext,
  input: IMergeDuplicateBacklogItemsInput,
): {
  readonly mergedBacklogItem: IBacklogItemRecord;
  readonly cancelledBacklogItems: readonly IBacklogItemRecord[];
} {
  if (input.duplicateBacklogItemIds.length === 0) {
    throw new Error("Provide at least one duplicate backlog item to merge.");
  }

  const duplicateBacklogItemIds = findDuplicateIds(input.duplicateBacklogItemIds);

  if (duplicateBacklogItemIds.length > 0) {
    throw new Error(
      `Duplicate backlog item ids cannot be merged twice in one request: ${duplicateBacklogItemIds.join(", ")}.`,
    );
  }

  if (input.duplicateBacklogItemIds.includes(input.targetBacklogItemId)) {
    throw new Error("The merge target cannot also be listed as a duplicate backlog item.");
  }

  const targetBacklogItem = requirePendingPlanningBacklogItem(
    context,
    input.targetBacklogItemId,
    "merge",
  );
  const duplicateBacklogItems = input.duplicateBacklogItemIds.map((backlogItemId) => {
    const duplicateBacklogItem = requirePendingPlanningBacklogItem(context, backlogItemId, "merge");

    if (duplicateBacklogItem.projectId !== targetBacklogItem.projectId) {
      throw new Error("Merged backlog items must stay within the same project.");
    }

    return duplicateBacklogItem;
  });
  const timestamp = new Date().toISOString();
  const mergedBacklogItem: IBacklogItemRecord = {
    ...targetBacklogItem,
    acceptanceCriteriaJson: JSON.stringify(
      mergeAcceptanceCriteria(targetBacklogItem, duplicateBacklogItems),
    ),
    priority: Math.max(
      targetBacklogItem.priority,
      ...duplicateBacklogItems.map((backlogItem) => backlogItem.priority),
    ),
    reviewMode: duplicateBacklogItems.some((backlogItem) => backlogItem.reviewMode === "human")
      ? "human"
      : targetBacklogItem.reviewMode,
    riskLevel: mergeRiskLevels(targetBacklogItem, duplicateBacklogItems),
    scopeSummary: mergeScopeSummaries(targetBacklogItem, duplicateBacklogItems),
    updatedAt: timestamp,
  };
  const cancelledBacklogItems = duplicateBacklogItems.map((backlogItem) => {
    const cancelledBacklogItem: IBacklogItemRecord = {
      ...backlogItem,
      status: "cancelled",
      updatedAt: timestamp,
    };

    upsertBacklogItem(context, cancelledBacklogItem);
    rewireBacklogDependenciesAfterReplacement(context, backlogItem.id, mergedBacklogItem.id);
    return cancelledBacklogItem;
  });

  upsertBacklogItem(context, mergedBacklogItem);
  recordPlanningMutation(
    context,
    targetBacklogItem.projectId,
    input.sourceThreadId,
    `Merged duplicate backlog items into "${mergedBacklogItem.title}": ${cancelledBacklogItems
      .map((backlogItem) => `"${backlogItem.title}"`)
      .join(", ")}.`,
    input.noteText,
    timestamp,
  );

  return {
    cancelledBacklogItems,
    mergedBacklogItem,
  };
}

export function markBacklogItemStaleFromPlanning(
  context: IContext,
  input: IMarkBacklogItemStaleInput,
): IBacklogItemRecord {
  const backlogItem = requirePendingPlanningBacklogItem(context, input.backlogItemId, "mark stale");
  const timestamp = new Date().toISOString();
  const staleBacklogItem: IBacklogItemRecord = {
    ...backlogItem,
    status: "cancelled",
    updatedAt: timestamp,
  };

  upsertBacklogItem(context, staleBacklogItem);
  recordPlanningMutation(
    context,
    backlogItem.projectId,
    input.sourceThreadId,
    `Marked backlog item "${backlogItem.title}" as stale and removed it from pending execution.`,
    input.noteText,
    timestamp,
  );

  return staleBacklogItem;
}

export function explainWhyBacklogItemIsNext(
  context: IContext,
  input: IExplainBacklogPriorityInput,
): IBacklogPriorityExplanation {
  const backlogItem = requireBacklogItem(context, input.backlogItemId);
  const activeTaskRun =
    listTaskRunsForProject(context, backlogItem.projectId).find((taskRun) => {
      return ACTIVE_TASK_RUN_STATUSES.has(taskRun.status);
    }) ?? null;
  const blockingReasons = listBacklogItemSchedulingBlockingReasons(context, backlogItem);
  const runnableBacklogItems = listRunnablePendingBacklogItems(context, backlogItem.projectId);
  const higherPriorityRunnableBacklogItems = runnableBacklogItems.filter((candidate) => {
    return candidate.id !== backlogItem.id && candidate.priority > backlogItem.priority;
  });
  const highestPriorityRunnableBacklogItem = runnableBacklogItems[0] ?? null;
  const isNext =
    blockingReasons.length === 0 && highestPriorityRunnableBacklogItem?.id === backlogItem.id;
  const explanation = buildBacklogPriorityExplanation(
    backlogItem,
    activeTaskRun,
    blockingReasons,
    higherPriorityRunnableBacklogItems,
    highestPriorityRunnableBacklogItem,
    isNext,
  );

  return {
    activeTaskRunId: activeTaskRun?.id ?? null,
    backlogItemId: backlogItem.id,
    blockingReasons,
    explanation,
    higherPriorityRunnableBacklogItemIds: higherPriorityRunnableBacklogItems.map(
      (candidate) => candidate.id,
    ),
    isNext,
    readyForExecution: blockingReasons.length === 0,
  };
}

export function removePendingBacklogItemFromPlanning(
  context: IContext,
  input: IRemovePendingBacklogItemInput,
): IBacklogItemRecord {
  const backlogItem = requireBacklogItem(context, input.backlogItemId);

  if (
    !PLANNING_REORDERABLE_BACKLOG_STATUSES.has(backlogItem.status) ||
    hasActiveTaskRunForBacklogItem(context, backlogItem.projectId, backlogItem.id)
  ) {
    throw new Error(
      `Backlog item ${backlogItem.id} cannot be removed because it is active or completed.`,
    );
  }

  const timestamp = new Date().toISOString();
  const removedBacklogItem: IBacklogItemRecord = {
    ...backlogItem,
    status: "cancelled",
    updatedAt: timestamp,
  };

  upsertBacklogItem(context, removedBacklogItem);
  recordPlanningMutation(
    context,
    backlogItem.projectId,
    input.sourceThreadId,
    `Removed pending backlog item "${backlogItem.title}" from the active planning set.`,
    input.noteText,
    timestamp,
  );

  return removedBacklogItem;
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

  assertActiveTaskScopeIsStable(context, backlogItem, input, normalizedAcceptanceCriteria);

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

export function reprioritizeBacklogItemForPlanning(
  context: IContext,
  input: IReprioritizeBacklogItemInput,
): IBacklogItemRecord {
  const backlogItem = requireBacklogItem(context, input.backlogItemId);
  const reorderableBacklogItems = listPlanningReorderableBacklogItems(context, backlogItem.projectId);
  const reorderableBacklogItem = reorderableBacklogItems.find((candidate) => candidate.id === backlogItem.id);

  if (reorderableBacklogItem === undefined) {
    throw new Error(
      `Backlog item ${backlogItem.id} cannot be reprioritized because it is active or completed.`,
    );
  }

  const timestamp = new Date().toISOString();
  const reprioritizedBacklogItem: IBacklogItemRecord = {
    ...backlogItem,
    priority: input.priority,
    updatedAt: timestamp,
  };

  upsertBacklogItem(context, reprioritizedBacklogItem);
  recordPlanningMutation(
    context,
    backlogItem.projectId,
    input.sourceThreadId,
    `Reprioritized backlog item "${backlogItem.title}" to priority ${input.priority}.`,
    input.noteText,
    timestamp,
  );

  return reprioritizedBacklogItem;
}

export function reorderPendingBacklogItems(
  context: IContext,
  input: IReorderPendingBacklogItemsInput,
): IBacklogItemRecord[] {
  if (input.backlogItemIds.length === 0) {
    throw new Error("Provide at least one pending backlog item to reorder.");
  }

  requireProject(input.projectId, context);

  const reorderableBacklogItems = listPlanningReorderableBacklogItems(context, input.projectId);
  const reorderableBacklogItemsById = new Map(
    reorderableBacklogItems.map((backlogItem) => [backlogItem.id, backlogItem] as const),
  );
  const duplicateBacklogItemIds = findDuplicateIds(input.backlogItemIds);

  if (duplicateBacklogItemIds.length > 0) {
    throw new Error(`Backlog item ids must be unique when reordering: ${duplicateBacklogItemIds.join(", ")}.`);
  }

  for (const backlogItemId of input.backlogItemIds) {
    if (!reorderableBacklogItemsById.has(backlogItemId)) {
      throw new Error(
        `Backlog item ${backlogItemId} cannot be reordered because it is missing, active, or completed.`,
      );
    }
  }

  const prioritizedBacklogItems = input.backlogItemIds.map((backlogItemId) => {
    return reorderableBacklogItemsById.get(backlogItemId) as IBacklogItemRecord;
  });
  const untouchedBacklogItems = reorderableBacklogItems.filter((backlogItem) => {
    return !input.backlogItemIds.includes(backlogItem.id);
  });
  const reorderedBacklogItems = [...prioritizedBacklogItems, ...untouchedBacklogItems];
  const timestamp = new Date().toISOString();
  const startingPriority = reorderedBacklogItems.length * 10;

  const updatedBacklogItems = reorderedBacklogItems.map((backlogItem, index) => {
    const reprioritizedBacklogItem: IBacklogItemRecord = {
      ...backlogItem,
      priority: startingPriority - index * 10,
      updatedAt: timestamp,
    };

    upsertBacklogItem(context, reprioritizedBacklogItem);
    return reprioritizedBacklogItem;
  });

  recordPlanningMutation(
    context,
    input.projectId,
    input.sourceThreadId,
    `Reordered pending backlog items: ${updatedBacklogItems
      .slice(0, input.backlogItemIds.length)
      .map((backlogItem) => backlogItem.title)
      .join(" -> ")}.`,
    input.noteText,
    timestamp,
  );

  return updatedBacklogItems;
}

export function addBacklogDependency(
  context: IContext,
  input: IAddBacklogDependencyInput,
): IBacklogDependencyRecord {
  if (input.blockingBacklogItemId === input.blockedBacklogItemId) {
    throw new Error("A backlog item cannot depend on itself.");
  }

  const blockingBacklogItem = requireBacklogItem(context, input.blockingBacklogItemId);
  const blockedBacklogItem = requireBacklogItem(context, input.blockedBacklogItemId);

  if (blockingBacklogItem.projectId !== blockedBacklogItem.projectId) {
    throw new Error("Dependency links must stay within the same project.");
  }

  const timestamp = new Date().toISOString();
  const dependencyRecord: IBacklogDependencyRecord = {
    blockedBacklogItemId: blockedBacklogItem.id,
    blockingBacklogItemId: blockingBacklogItem.id,
    createdAt: timestamp,
    projectId: blockingBacklogItem.projectId,
    updatedAt: timestamp,
  };

  upsertBacklogDependencyLink(context, dependencyRecord);
  recordPlanningMutation(
    context,
    blockingBacklogItem.projectId,
    input.sourceThreadId,
    `Linked dependency: "${blockedBacklogItem.title}" is blocked by "${blockingBacklogItem.title}".`,
    input.noteText,
    timestamp,
  );

  return dependencyRecord;
}

export function removeBacklogDependency(
  context: IContext,
  input: IRemoveBacklogDependencyInput,
): boolean {
  const blockingBacklogItem = requireBacklogItem(context, input.blockingBacklogItemId);
  const blockedBacklogItem = requireBacklogItem(context, input.blockedBacklogItemId);

  if (blockingBacklogItem.projectId !== blockedBacklogItem.projectId) {
    throw new Error("Dependency links must stay within the same project.");
  }

  const removed = deleteBacklogDependencyLink(
    context,
    input.blockingBacklogItemId,
    input.blockedBacklogItemId,
  );

  if (!removed) {
    return false;
  }

  recordPlanningMutation(
    context,
    blockingBacklogItem.projectId,
    input.sourceThreadId,
    `Removed dependency: "${blockedBacklogItem.title}" is no longer blocked by "${blockingBacklogItem.title}".`,
    input.noteText,
    new Date().toISOString(),
  );

  return true;
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

function requirePendingPlanningBacklogItem(
  context: IContext,
  backlogItemId: string,
  actionText: string,
): IBacklogItemRecord {
  const backlogItem = requireBacklogItem(context, backlogItemId);

  if (
    !PLANNING_REORDERABLE_BACKLOG_STATUSES.has(backlogItem.status) ||
    hasActiveTaskRunForBacklogItem(context, backlogItem.projectId, backlogItem.id)
  ) {
    throw new Error(
      `Backlog item ${backlogItem.id} cannot ${actionText} because it is active or completed.`,
    );
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

function createPlanningBacklogItem(
  context: IContext,
  input: {
    readonly acceptanceCriteria?: readonly string[];
    readonly priority?: number;
    readonly projectId: string;
    readonly readiness?: IBacklogItemRecord["readiness"];
    readonly reviewMode?: ReviewMode;
    readonly riskLevel?: RiskLevel;
    readonly scopeSummary: string;
    readonly status?: IBacklogItemRecord["status"];
    readonly title: string;
  },
): IBacklogItemRecord {
  const timestamp = new Date().toISOString();
  const backlogItemId = `backlog-${randomUUID()}`;
  const taskThreadId = `thread-task-${randomUUID()}`;
  const backlogItem: IBacklogItemRecord = {
    acceptanceCriteriaJson: JSON.stringify(
      (input.acceptanceCriteria ?? [])
        .map((criterion) => criterion.trim())
        .filter((criterion) => criterion.length > 0),
    ),
    createdAt: timestamp,
    id: backlogItemId,
    priority: input.priority ?? 10,
    projectId: input.projectId,
    readiness: input.readiness ?? "not_ready",
    reviewMode: input.reviewMode ?? "human",
    riskLevel: input.riskLevel ?? "low",
    scopeSummary: input.scopeSummary,
    status: input.status ?? "draft",
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
      taskThreadId,
      "system",
      "Refine scope and acceptance criteria before requesting approval.",
      timestamp,
    ),
  );

  return backlogItem;
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

function recordPlanningMutation(
  context: IContext,
  projectId: string,
  sourceThreadId: string | undefined,
  toolMessage: string,
  noteText: string | undefined,
  timestamp: string,
): void {
  if (sourceThreadId === undefined) {
    return;
  }

  const sourceThread = requireThreadById(context, projectId, sourceThreadId);

  upsertChatMessage(context, createMessage(sourceThread.id, "tool", toolMessage, timestamp));

  if (noteText?.trim()) {
    upsertChatMessage(context, createMessage(sourceThread.id, "human", noteText.trim(), timestamp));
  }

  upsertChatThread(context, {
    ...sourceThread,
    updatedAt: timestamp,
  });
}

function listPlanningReorderableBacklogItems(
  context: IContext,
  projectId: string,
): IBacklogItemRecord[] {
  const activeBacklogItemIds = new Set(
    listTaskRunsForProject(context, projectId)
      .filter((taskRun) => ACTIVE_TASK_RUN_STATUSES.has(taskRun.status))
      .map((taskRun) => taskRun.backlogItemId),
  );

  return listBacklogItemsForProject(context, projectId).filter((backlogItem) => {
    return (
      PLANNING_REORDERABLE_BACKLOG_STATUSES.has(backlogItem.status) &&
      !activeBacklogItemIds.has(backlogItem.id)
    );
  });
}

function findDuplicateIds(ids: readonly string[]): string[] {
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const id of ids) {
    if (seenIds.has(id)) {
      duplicateIds.add(id);
      continue;
    }

    seenIds.add(id);
  }

  return [...duplicateIds];
}

function mergeAcceptanceCriteria(
  targetBacklogItem: IBacklogItemRecord,
  duplicateBacklogItems: readonly IBacklogItemRecord[],
): string[] {
  return [
    ...parseAcceptanceCriteria(targetBacklogItem),
    ...duplicateBacklogItems.flatMap((backlogItem) => parseAcceptanceCriteria(backlogItem)),
  ].filter((criterion, index, criteria) => {
    return criteria.indexOf(criterion) === index;
  });
}

function parseAcceptanceCriteria(backlogItem: IBacklogItemRecord): string[] {
  try {
    const criteria = JSON.parse(backlogItem.acceptanceCriteriaJson) as unknown;

    if (!Array.isArray(criteria)) {
      return [];
    }

    return criteria.filter((criterion): criterion is string => typeof criterion === "string");
  } catch {
    return [];
  }
}

function mergeScopeSummaries(
  targetBacklogItem: IBacklogItemRecord,
  duplicateBacklogItems: readonly IBacklogItemRecord[],
): string {
  const mergedSummaries = duplicateBacklogItems
    .map((backlogItem) => {
      const scopeSummary = backlogItem.scopeSummary?.trim() ?? "";

      if (scopeSummary.length === 0 || scopeSummary === (targetBacklogItem.scopeSummary ?? "")) {
        return null;
      }

      return `Merged duplicate "${backlogItem.title}": ${scopeSummary}`;
    })
    .filter((scopeSummary): scopeSummary is string => scopeSummary !== null);

  if (mergedSummaries.length === 0) {
    return targetBacklogItem.scopeSummary ?? "";
  }

  return [targetBacklogItem.scopeSummary?.trim() ?? "", ...mergedSummaries]
    .filter((scopeSummary) => scopeSummary.length > 0)
    .join("\n\n");
}

function mergeRiskLevels(
  targetBacklogItem: IBacklogItemRecord,
  duplicateBacklogItems: readonly IBacklogItemRecord[],
): RiskLevel {
  const riskOrder: Record<RiskLevel, number> = {
    high: 3,
    low: 1,
    medium: 2,
  };

  return [targetBacklogItem, ...duplicateBacklogItems].reduce<RiskLevel>((currentRisk, backlogItem) => {
    return riskOrder[backlogItem.riskLevel] > riskOrder[currentRisk]
      ? backlogItem.riskLevel
      : currentRisk;
  }, targetBacklogItem.riskLevel);
}

function rewireBacklogDependenciesAfterReplacement(
  context: IContext,
  sourceBacklogItemId: string,
  replacementBacklogItemId: string | undefined,
): void {
  const dependencyLinks = listBacklogDependencyLinksForProject(
    context,
    requireBacklogItem(context, sourceBacklogItemId).projectId,
  ).filter((dependency) => {
    return (
      dependency.blockedBacklogItemId === sourceBacklogItemId ||
      dependency.blockingBacklogItemId === sourceBacklogItemId
    );
  });

  for (const dependency of dependencyLinks) {
    deleteBacklogDependencyLink(
      context,
      dependency.blockingBacklogItemId,
      dependency.blockedBacklogItemId,
    );

    if (
      replacementBacklogItemId === undefined ||
      (dependency.blockingBacklogItemId === sourceBacklogItemId
        ? replacementBacklogItemId
        : dependency.blockingBacklogItemId) ===
        (dependency.blockedBacklogItemId === sourceBacklogItemId
          ? replacementBacklogItemId
          : dependency.blockedBacklogItemId)
    ) {
      continue;
    }

    upsertBacklogDependencyLink(context, {
      blockedBacklogItemId:
        dependency.blockedBacklogItemId === sourceBacklogItemId
          ? replacementBacklogItemId
          : dependency.blockedBacklogItemId,
      blockingBacklogItemId:
        dependency.blockingBacklogItemId === sourceBacklogItemId
          ? replacementBacklogItemId
          : dependency.blockingBacklogItemId,
      createdAt: dependency.createdAt,
      projectId: dependency.projectId,
      updatedAt: new Date().toISOString(),
    });
  }
}

function listBacklogItemSchedulingBlockingReasons(
  context: IContext,
  backlogItem: IBacklogItemRecord,
): string[] {
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

  const unclearedDependencies = listUnclearedDependencyLinks(context, backlogItem);

  if (unclearedDependencies.length > 0) {
    const blockingTitles = unclearedDependencies
      .map((dependency) => getBacklogItemById(context, dependency.blockingBacklogItemId)?.title)
      .filter((title): title is string => title !== undefined);
    blockingReasons.push(
      `dependencies are not cleared${blockingTitles.length > 0 ? ` (${blockingTitles.join(", ")})` : ""}`,
    );
  }

  return blockingReasons;
}

function listRunnablePendingBacklogItems(
  context: IContext,
  projectId: string,
): IBacklogItemRecord[] {
  return listBacklogItemsForProject(context, projectId).filter((backlogItem) => {
    return (
      backlogItem.status === "approved" &&
      !hasActiveTaskRunForBacklogItem(context, projectId, backlogItem.id) &&
      listBacklogItemSchedulingBlockingReasons(context, backlogItem).length === 0
    );
  });
}

function buildBacklogPriorityExplanation(
  backlogItem: IBacklogItemRecord,
  activeTaskRun: ITaskRunRecord | null,
  blockingReasons: readonly string[],
  higherPriorityRunnableBacklogItems: readonly IBacklogItemRecord[],
  highestPriorityRunnableBacklogItem: IBacklogItemRecord | null,
  isNext: boolean,
): string {
  if (isNext) {
    return [
      `Backlog item "${backlogItem.title}" is next because it is approved, ready, and unblocked.`,
      higherPriorityRunnableBacklogItems.length === 0
        ? "No higher-priority runnable backlog item is ahead of it."
        : `Higher-priority runnable work still exists: ${higherPriorityRunnableBacklogItems
            .map((candidate) => candidate.title)
            .join(", ")}.`,
      activeTaskRun === null
        ? "No active coding task is currently running in this project."
        : `The current active task run is ${activeTaskRun.id}; this item remains the next runnable candidate after it clears.`,
    ].join(" ");
  }

  if (blockingReasons.length > 0) {
    return `Backlog item "${backlogItem.title}" is not next because ${blockingReasons.join(", ")}.`;
  }

  if (highestPriorityRunnableBacklogItem !== null) {
    return `Backlog item "${backlogItem.title}" is runnable, but "${highestPriorityRunnableBacklogItem.title}" has a higher pending priority and is ahead in the execution queue.`;
  }

  return `Backlog item "${backlogItem.title}" is not next because there is no runnable approved-and-ready work in the project yet.`;
}

function assertActiveTaskScopeIsStable(
  context: IContext,
  backlogItem: IBacklogItemRecord,
  input: IReviseBacklogItemInput,
  normalizedAcceptanceCriteria: readonly string[],
): void {
  if (!hasActiveTaskRunForBacklogItem(context, backlogItem.projectId, backlogItem.id)) {
    return;
  }

  const acceptanceCriteriaChanged =
    backlogItem.acceptanceCriteriaJson !== JSON.stringify(normalizedAcceptanceCriteria);
  const scopeChanged = (backlogItem.scopeSummary ?? "") !== input.scopeSummary;
  const priorityChanged =
    input.priority !== undefined && backlogItem.priority !== input.priority;
  const readinessChanged =
    input.readiness !== undefined && backlogItem.readiness !== input.readiness;
  const reviewModeChanged =
    input.reviewMode !== undefined && backlogItem.reviewMode !== input.reviewMode;
  const riskLevelChanged =
    input.riskLevel !== undefined && backlogItem.riskLevel !== input.riskLevel;
  const statusChanged = input.status !== undefined && backlogItem.status !== input.status;

  if (
    !acceptanceCriteriaChanged &&
    !scopeChanged &&
    !priorityChanged &&
    !readinessChanged &&
    !reviewModeChanged &&
    !riskLevelChanged &&
    !statusChanged
  ) {
    return;
  }

  throw new Error(
    `Backlog item ${backlogItem.id} is actively running. Pause and replan it or create a follow-up task instead of silently mutating the active scope.`,
  );
}

function hasActiveTaskRunForBacklogItem(
  context: IContext,
  projectId: string,
  backlogItemId: string,
): boolean {
  return listTaskRunsForProject(context, projectId).some((taskRun) => {
    return (
      taskRun.backlogItemId === backlogItemId && ACTIVE_TASK_RUN_STATUSES.has(taskRun.status)
    );
  });
}

function assertBacklogItemReadyForExecution(
  context: IContext,
  backlogItem: IBacklogItemRecord,
): void {
  const blockingReasons = listBacklogItemSchedulingBlockingReasons(context, backlogItem);

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

function listUnclearedDependencyLinks(
  context: IContext,
  backlogItem: IBacklogItemRecord,
): IBacklogDependencyRecord[] {
  return listBacklogDependencyLinksForProject(context, backlogItem.projectId).filter(
    (dependency) => {
      if (dependency.blockedBacklogItemId !== backlogItem.id) {
        return false;
      }

      const blockingBacklogItem = getBacklogItemById(context, dependency.blockingBacklogItemId);

      return blockingBacklogItem?.status !== "done";
    },
  );
}

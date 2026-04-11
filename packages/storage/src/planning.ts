import { randomUUID } from "node:crypto";

import type {
  IBacklogItemRecord,
  IChatMessageRecord,
  IChatThreadRecord,
  IContext,
  ITaskRunRecord,
  ReviewMode,
  RiskLevel,
  WorkerKind,
} from "@smithly/core";

import {
  getBacklogItemById,
  listChatThreadsForProject,
  listTaskRunsForProject,
  upsertBacklogItem,
  upsertChatMessage,
  upsertChatThread,
  upsertTaskRun,
} from "./data.ts";

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
  readonly reviewMode?: ReviewMode;
  readonly riskLevel?: RiskLevel;
  readonly sourceThreadId?: string;
  readonly status?: IBacklogItemRecord["status"];
}

export interface IStartCodingTaskInput {
  readonly backlogItemId: string;
  readonly assignedWorker?: WorkerKind;
  readonly summaryText?: string;
}

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

  const timestamp = new Date().toISOString();
  const taskRun: ITaskRunRecord = {
    assignedWorker,
    backlogItemId: backlogItem.id,
    createdAt: timestamp,
    id: `taskrun-${randomUUID()}`,
    projectId: backlogItem.projectId,
    ...(input.summaryText?.trim()
      ? { summaryText: input.summaryText.trim() }
      : { summaryText: `Start ${assignedWorker} work for ${backlogItem.title}.` }),
    status: "queued",
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

function requireBacklogItem(context: IContext, backlogItemId: string): IBacklogItemRecord {
  const backlogItem = getBacklogItemById(context, backlogItemId);

  if (backlogItem === null) {
    throw new Error(`Missing backlog item ${backlogItemId}`);
  }

  return backlogItem;
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

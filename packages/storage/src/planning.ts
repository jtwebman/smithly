import { randomUUID } from "node:crypto";

import type {
  IBacklogItemRecord,
  IChatMessageRecord,
  IChatThreadRecord,
  IContext,
} from "@smithly/core";

import {
  getBacklogItemById,
  listChatThreadsForProject,
  upsertBacklogItem,
  upsertChatMessage,
  upsertChatThread,
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
  readonly sourceThreadId?: string;
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
    scopeSummary: input.scopeSummary,
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
        `Updated backlog item "${backlogItem.title}" with ${normalizedAcceptanceCriteria.length} acceptance criteria.`,
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

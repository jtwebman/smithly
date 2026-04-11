import { randomUUID } from "node:crypto";

import type {
  BacklogItemStatus,
  IBacklogItemRecord,
  IReviewRunRecord,
  ITaskRunRecord,
  ReviewRunStatus,
} from "@smithly/core";
import {
  getBacklogItemById,
  type IStorageContext,
  listProjects,
  listReviewRunsForTask,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  upsertBacklogItem,
  upsertReviewRun,
  upsertTaskRun,
} from "@smithly/storage";

export function queueRequiredReviewRun(
  context: IStorageContext,
  taskRun: ITaskRunRecord,
  timestamp: string,
): IReviewRunRecord | null {
  const backlogItem = getBacklogItemById(context, taskRun.backlogItemId);

  if (backlogItem === null) {
    return null;
  }

  const reviewerKind =
    backlogItem.reviewMode === "human"
      ? "human"
      : taskRun.assignedWorker === "codex"
        ? "claude"
        : "codex";
  const existingReviewRun = listReviewRunsForTask(context, taskRun.id).find((reviewRun) => {
    return reviewRun.reviewerKind === reviewerKind;
  });

  if (existingReviewRun !== undefined) {
    return existingReviewRun;
  }

  const reviewRun: IReviewRunRecord = {
    createdAt: timestamp,
    id: `review-${randomUUID()}`,
    projectId: taskRun.projectId,
    reviewerKind,
    status: "queued",
    summaryText:
      reviewerKind === "human"
        ? "Operator review is required before this task can be marked done."
        : `${reviewerKind} peer review queued for ${taskRun.assignedWorker} work.`,
    taskRunId: taskRun.id,
    updatedAt: timestamp,
  };

  upsertReviewRun(context, reviewRun);
  return reviewRun;
}

export function reconcileTaskReviewState(
  context: IStorageContext,
  taskRunId: string,
  timestamp: string,
): ITaskRunRecord | null {
  const taskRun = findTaskRun(context, taskRunId);

  if (taskRun === null) {
    return null;
  }

  if (["queued", "running", "blocked", "failed", "cancelled"].includes(taskRun.status)) {
    return taskRun;
  }

  const backlogItem = getBacklogItemById(context, taskRun.backlogItemId);

  if (backlogItem === null) {
    return taskRun;
  }

  const relevantReviewRun = getRelevantReviewRun(context, taskRun, backlogItem);
  const verificationRuns = listVerificationRunsForTask(context, taskRun.id);
  const hasPendingVerification = verificationRuns.some((verificationRun) => {
    return ["queued", "running"].includes(verificationRun.status);
  });
  const hasFailedVerification = verificationRuns.some((verificationRun) => {
    return ["failed", "cancelled"].includes(verificationRun.status);
  });
  const nextTaskStatus =
    relevantReviewRun === null ||
    ["queued", "running"].includes(relevantReviewRun.status) ||
    hasPendingVerification ||
    hasFailedVerification ||
    ["changes_requested", "failed"].includes(relevantReviewRun.status)
      ? "awaiting_review"
      : "done";

  const nextBacklogStatus: BacklogItemStatus = nextTaskStatus === "done" ? "done" : "in_progress";

  if (taskRun.status !== nextTaskStatus) {
    upsertTaskRun(context, {
      ...taskRun,
      status: nextTaskStatus,
      updatedAt: timestamp,
    });
  }

  if (backlogItem.status !== nextBacklogStatus) {
    upsertBacklogItem(context, {
      ...backlogItem,
      status: nextBacklogStatus,
      updatedAt: timestamp,
    });
  }

  return findTaskRun(context, taskRunId);
}

export function updateReviewRunDecision(
  context: IStorageContext,
  reviewRunId: string,
  status: Extract<ReviewRunStatus, "approved" | "changes_requested">,
  timestamp: string,
  summaryText?: string,
): IReviewRunRecord {
  const reviewRun = findReviewRun(context, reviewRunId);

  if (reviewRun === null) {
    throw new Error(`Missing review run ${reviewRunId}`);
  }

  const updatedReviewRun: IReviewRunRecord = {
    ...reviewRun,
    completedAt: timestamp,
    status,
    ...(summaryText !== undefined ? { summaryText } : {}),
    updatedAt: timestamp,
  };

  upsertReviewRun(context, updatedReviewRun);
  reconcileTaskReviewState(context, reviewRun.taskRunId, timestamp);
  return updatedReviewRun;
}

function getRelevantReviewRun(
  context: IStorageContext,
  taskRun: ITaskRunRecord,
  backlogItem: IBacklogItemRecord,
): IReviewRunRecord | null {
  const reviewerKind =
    backlogItem.reviewMode === "human"
      ? "human"
      : taskRun.assignedWorker === "codex"
        ? "claude"
        : "codex";
  const relevantReviewRuns = listReviewRunsForTask(context, taskRun.id)
    .filter((reviewRun) => reviewRun.reviewerKind === reviewerKind)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return relevantReviewRuns[0] ?? null;
}

function findReviewRun(context: IStorageContext, reviewRunId: string): IReviewRunRecord | null {
  for (const taskRun of listAllTaskRuns(context)) {
    const reviewRun = listReviewRunsForTask(context, taskRun.id).find((candidate) => {
      return candidate.id === reviewRunId;
    });

    if (reviewRun !== undefined) {
      return reviewRun;
    }
  }

  return null;
}

function findTaskRun(context: IStorageContext, taskRunId: string): ITaskRunRecord | null {
  return listAllTaskRuns(context).find((taskRun) => taskRun.id === taskRunId) ?? null;
}

function listAllTaskRuns(context: IStorageContext): readonly ITaskRunRecord[] {
  return listProjects(context).flatMap((project) => listTaskRunsForProject(context, project.id));
}

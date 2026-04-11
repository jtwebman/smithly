import {
  getProjectById,
  listProjects,
  listReviewRunsForTask,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  upsertReviewRun,
  type IStorageContext,
} from "@smithly/storage";

import { reconcileTaskReviewState } from "./task-review-policy.ts";

export interface IReviewManagerOptions {
  readonly now?: () => Date;
  readonly onUpdated?: () => void;
}

export class ReviewManager {
  private readonly activeReviewRunIds = new Set<string>();
  private readonly now: () => Date;
  private readonly onUpdated: () => void;

  public constructor(
    private readonly context: IStorageContext,
    options: IReviewManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onUpdated = options.onUpdated ?? (() => undefined);
  }

  public processQueuedRuns(): void {
    for (const project of listProjects(this.context)) {
      for (const taskRun of listTaskRunsForProject(this.context, project.id)) {
        for (const reviewRun of listReviewRunsForTask(this.context, taskRun.id)) {
          if (reviewRun.status !== "queued" || reviewRun.reviewerKind === "human") {
            continue;
          }

          if (this.activeReviewRunIds.has(reviewRun.id)) {
            continue;
          }

          this.completeAiReview(reviewRun.id, project.id, taskRun.id);
        }
      }
    }
  }

  private completeAiReview(reviewRunId: string, projectId: string, taskRunId: string): void {
    const reviewRun = listReviewRunsForTask(this.context, taskRunId).find((candidate) => {
      return candidate.id === reviewRunId;
    });
    const taskRun = listTaskRunsForProject(this.context, projectId).find((candidate) => {
      return candidate.id === taskRunId;
    });
    const project = getProjectById(this.context, projectId);

    if (reviewRun === undefined || taskRun === undefined || project === null) {
      return;
    }

    const startedAt = this.now().toISOString();
    this.activeReviewRunIds.add(reviewRun.id);
    upsertReviewRun(this.context, {
      ...reviewRun,
      status: "running",
      summaryText: `${reviewRun.reviewerKind} review is evaluating ${taskRun.summaryText ?? taskRun.id}.`,
      updatedAt: startedAt,
    });
    this.onUpdated();

    const verificationRuns = listVerificationRunsForTask(this.context, taskRun.id);
    const failedVerificationRun = verificationRuns.find((verificationRun) => {
      return verificationRun.status === "failed";
    });
    const completedAt = this.now().toISOString();

    upsertReviewRun(this.context, {
      ...reviewRun,
      completedAt,
      status: failedVerificationRun === undefined ? "approved" : "changes_requested",
      summaryText:
        failedVerificationRun === undefined
          ? `${reviewRun.reviewerKind} approved ${taskRun.assignedWorker} work after ${verificationRuns.filter((verificationRun) => verificationRun.status === "passed").length} passing verification run(s).`
          : `${reviewRun.reviewerKind} requested changes after verification failed: ${failedVerificationRun.commandText}.`,
      updatedAt: completedAt,
    });
    this.activeReviewRunIds.delete(reviewRun.id);
    reconcileTaskReviewState(this.context, taskRun.id, completedAt);
    this.onUpdated();
  }
}

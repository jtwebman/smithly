import { getBacklogItemById } from "@smithly/storage";
import {
  listBacklogDependencyLinksForProject,
  listBlockersForProject,
  listProjects,
  listTaskRunsForProject,
  upsertBlocker,
  type IStorageContext,
} from "@smithly/storage";

import { TaskGitManager } from "./task-git-manager.ts";
import { reconcileTaskReviewState } from "./task-review-policy.ts";

export interface ITaskMergeManagerOptions {
  readonly now?: () => Date;
  readonly taskGitManager?: TaskGitManager;
}

export class TaskMergeManager {
  private readonly now: () => Date;
  private readonly taskGitManager: TaskGitManager;

  public constructor(
    private readonly context: IStorageContext,
    options: ITaskMergeManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.taskGitManager = options.taskGitManager ?? new TaskGitManager(context);
  }

  public mergeTaskRun(taskRunId: string): void {
    this.taskGitManager.mergePullRequest(taskRunId);
    this.syncDependentBlockers(taskRunId);
    reconcileTaskReviewState(this.context, taskRunId, this.now().toISOString());
  }

  public syncDependentBlockers(taskRunId: string): void {
    const taskRun = this.findTaskRun(taskRunId);

    if (taskRun === null) {
      return;
    }

    const backlogItem = getBacklogItemById(this.context, taskRun.backlogItemId);

    if (backlogItem === null) {
      return;
    }

    const taskGitState = this.taskGitManager.getTaskGitState(taskRunId);
    const isMerged = taskGitState?.status === "merged";
    const timestamp = this.now().toISOString();
    const dependentItems = listBacklogDependencyLinksForProject(
      this.context,
      backlogItem.projectId,
    )
      .filter((dependency) => dependency.blockingBacklogItemId === backlogItem.id)
      .flatMap((dependency) => {
        const dependentItem = getBacklogItemById(this.context, dependency.blockedBacklogItemId);
        return dependentItem === null ? [] : [dependentItem];
      });

    for (const dependentItem of dependentItems) {
      const blockerId = buildDependentMergeBlockerId(taskRunId, dependentItem.id);
      const existingBlocker = listBlockersForProject(this.context, backlogItem.projectId).find(
        (candidate) => candidate.id === blockerId,
      );

      if (isMerged) {
        if (existingBlocker?.status === "open") {
          upsertBlocker(this.context, {
            ...existingBlocker,
            resolutionNote: "The parent task pull request has merged.",
            resolvedAt: timestamp,
            status: "resolved",
            updatedAt: timestamp,
          });
        }

        continue;
      }

      upsertBlocker(this.context, {
        backlogItemId: dependentItem.id,
        blockerType: "system",
        createdAt: existingBlocker?.createdAt ?? timestamp,
        detail: `Dependent work is waiting for ${backlogItem.title} to merge before it can safely proceed.`,
        id: blockerId,
        projectId: backlogItem.projectId,
        status: "open",
        title: "Waiting for parent task merge",
        updatedAt: timestamp,
      });
    }
  }

  private findTaskRun(taskRunId: string) {
    return (
      listProjects(this.context)
        .flatMap((project) => listTaskRunsForProject(this.context, project.id))
        .find((candidate) => candidate.id === taskRunId) ?? null
    );
  }
}

export function buildDependentMergeBlockerId(taskRunId: string, backlogItemId: string): string {
  return `blocker-merge-dependency-${taskRunId}-${backlogItemId}`;
}

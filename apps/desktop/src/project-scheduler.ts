import type { ITaskRunRecord } from "@smithly/core";
import {
  getProjectById,
  listProjects,
  listTaskRunsForProject,
  selectNextRunnableBacklogItemForProject,
  type IStorageContext,
} from "@smithly/storage";

import { resolveProjectExecutionState } from "./project-execution.ts";

const ACTIVE_CODING_TASK_STATUSES = new Set<ITaskRunRecord["status"]>([
  "queued",
  "running",
  "blocked",
  "awaiting_review",
]);
const RESUMABLE_CODING_TASK_STATUSES = new Set<ITaskRunRecord["status"]>([
  "queued",
  "running",
  "blocked",
]);

export interface IProjectTaskController {
  ensureSession(taskRunId: string): void;
  startSession(input: {
    readonly backlogItemId: string;
    readonly projectId: string;
    readonly summaryText?: string;
  }): ITaskRunRecord;
}

export class ProjectSchedulingManager {
  public constructor(
    private readonly context: IStorageContext,
    private readonly taskController: IProjectTaskController,
  ) {}

  public processActiveProjects(): boolean {
    let changed = false;

    for (const project of listProjects(this.context)) {
      if (project.status !== "active") {
        continue;
      }

      if (this.processProject(project.id)) {
        changed = true;
      }
    }

    return changed;
  }

  private processProject(projectId: string): boolean {
    const project = getProjectById(this.context, projectId);

    if (project === null || resolveProjectExecutionState(this.context, projectId) !== "active") {
      return false;
    }

    const activeTaskRun = listTaskRunsForProject(this.context, projectId).find((taskRun) => {
      return ACTIVE_CODING_TASK_STATUSES.has(taskRun.status);
    });

    if (activeTaskRun !== undefined) {
      if (
        activeTaskRun.assignedWorker === "codex" &&
        RESUMABLE_CODING_TASK_STATUSES.has(activeTaskRun.status)
      ) {
        this.taskController.ensureSession(activeTaskRun.id);
      }

      return false;
    }

    const nextBacklogItem = selectNextRunnableBacklogItemForProject(this.context, projectId);

    if (nextBacklogItem === null) {
      return false;
    }

    this.taskController.startSession({
      backlogItemId: nextBacklogItem.id,
      projectId,
      summaryText: `Start Codex work for the next runnable backlog item: ${nextBacklogItem.title}.`,
    });

    return true;
  }
}

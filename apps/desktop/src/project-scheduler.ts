import type { ITaskRunRecord } from "@smithly/core";
import {
  ensureProjectPlanningThread,
  getProjectById,
  listApprovalsForProject,
  listBlockersForProject,
  listChatMessagesForThread,
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

export interface IProjectPlanningController {
  submitInput(input: {
    readonly bodyText: string;
    readonly projectId: string;
    readonly scope: "project";
  }): void;
}

export class ProjectSchedulingManager {
  public constructor(
    private readonly context: IStorageContext,
    private readonly taskController: IProjectTaskController,
    private readonly planningController?: IProjectPlanningController,
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
    const executionState =
      project === null ? null : resolveProjectExecutionState(this.context, projectId);

    if (project === null) {
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

    if (executionState !== null && executionState !== "active") {
      return this.processPlanningLoops(projectId, executionState);
    }

    if (nextBacklogItem === null) {
      return this.processPlanningLoops(projectId, "active");
    }

    this.taskController.startSession({
      backlogItemId: nextBacklogItem.id,
      projectId,
      summaryText: `Start Codex work for the next runnable backlog item: ${nextBacklogItem.title}.`,
    });

    return true;
  }

  private processPlanningLoops(
    projectId: string,
    executionState: "active" | "blocked" | "waiting_for_credit" | "waiting_for_human" | "paused",
  ): boolean {
    if (this.planningController === undefined) {
      return false;
    }

    const prompts = this.buildPlanningLoopPrompts(projectId, executionState);
    const planningThread = ensureProjectPlanningThread(this.context, projectId);
    const existingPrompts = new Set(
      listChatMessagesForThread(this.context, planningThread.id)
        .filter((message) => message.role === "human")
        .map((message) => message.bodyText),
    );

    for (const prompt of prompts) {
      if (existingPrompts.has(prompt)) {
        continue;
      }

      this.planningController.submitInput({
        bodyText: prompt,
        projectId,
        scope: "project",
      });

      return true;
    }

    return false;
  }

  private buildPlanningLoopPrompts(
    projectId: string,
    executionState: "active" | "blocked" | "waiting_for_credit" | "waiting_for_human" | "paused",
  ): readonly string[] {
    const prompts: string[] = [];

    if (["blocked", "waiting_for_credit", "waiting_for_human"].includes(executionState)) {
      prompts.push(
        this.buildIdleBacklogGenerationPrompt(
          projectId,
          executionState as "blocked" | "waiting_for_credit" | "waiting_for_human",
        ),
      );
    }

    prompts.push(this.buildSecurityAuditPrompt());
    return prompts;
  }

  private buildIdleBacklogGenerationPrompt(
    projectId: string,
    executionState: "blocked" | "waiting_for_credit" | "waiting_for_human",
  ): string {
    const pendingApprovals = listApprovalsForProject(this.context, projectId).filter((approval) => {
      return approval.status === "pending";
    });
    const openBlockers = listBlockersForProject(this.context, projectId).filter((blocker) => {
      return blocker.status === "open";
    });
    const blockerTitles =
      openBlockers
        .slice(0, 3)
        .map((blocker) => blocker.title)
        .join("; ") || "none";
    const approvalTitles =
      pendingApprovals
        .slice(0, 3)
        .map((approval) => approval.title)
        .join("; ") || "none";

    const reasonSummary =
      executionState === "blocked"
        ? `The project is blocked on external dependencies or system issues. Open blockers: ${blockerTitles}.`
        : executionState === "waiting_for_credit"
          ? "The project is waiting on provider credits or quota before coding can resume."
          : `The project is waiting on human input or approval. Pending approvals: ${approvalTitles}.`;

    return [
      "Run the default idle backlog-generation loop for this project.",
      reasonSummary,
      "Do not mutate approved backlog items or the scope of any active task.",
      "Instead, identify a small set of useful draft backlog items or draft refinements that can move the project forward while execution is waiting.",
      "Prefer reviewable work that reduces risk, prepares follow-on execution, or addresses likely unblockers.",
      "Use Smithly MCP tools to record the drafted work and explain briefly why each item helps.",
    ].join(" ");
  }

  private buildSecurityAuditPrompt(): string {
    return [
      "Run the default security-audit loop for this project.",
      "Review the full codebase for concrete security weaknesses, insecure defaults, secrets handling risks, authorization gaps, dependency exposure, and unsafe operational assumptions.",
      "Do not mutate approved backlog items or the scope of any active task.",
      "Draft a small set of human-reviewed backlog items for the highest-value security follow-ups you find.",
      "Each draft should explain the risk, the likely impact, and the smallest pragmatic remediation slice.",
      "Use Smithly MCP tools to record the backlog items with human review mode.",
    ].join(" ");
  }
}

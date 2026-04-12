import type { IApprovalRecord, IBlockerRecord, IProjectRecord, ProjectExecutionState } from "@smithly/core";
import {
  getProjectById,
  listApprovalsForProject,
  listBlockersForProject,
  listProjects,
  parseProjectMetadata,
  updateProjectMetadata,
  type IStorageContext,
} from "@smithly/storage";

export interface IProjectOrchestrationController {
  ensureSession(input: { readonly projectId: string; readonly scope: "project" }): void;
  requestProjectPause(projectId: string, reason?: string): Promise<void>;
}

export class ProjectExecutionManager {
  public constructor(
    private readonly context: IStorageContext,
    private readonly orchestrationController: IProjectOrchestrationController,
  ) {}

  public playProject(projectId: string): IProjectRecord {
    const project = this.requireProject(projectId);

    if (project.status === "archived") {
      throw new Error(`Archived project ${projectId} cannot be played.`);
    }

    const updatedProject =
      project.status === "active"
        ? project
        : updateProjectMetadata(this.context, {
            executionState: "active",
            projectId,
            status: "active",
          });

    this.orchestrationController.ensureSession({
      projectId,
      scope: "project",
    });

    return updatedProject;
  }

  public async pauseProject(projectId: string, reason?: string): Promise<IProjectRecord> {
    const project = this.requireProject(projectId);

    if (project.status === "archived") {
      return project;
    }

    const updatedProject =
      project.status === "paused"
        ? project
        : updateProjectMetadata(this.context, {
            executionState: "paused",
            projectId,
            status: "paused",
          });

    await this.orchestrationController.requestProjectPause(
      projectId,
      reason ?? "Pause project execution and drain the active orchestration session safely.",
    );

    return updatedProject;
  }

  public resumeActiveProjects(): void {
    for (const project of listProjects(this.context)) {
      if (project.status !== "active") {
        continue;
      }

      this.orchestrationController.ensureSession({
        projectId: project.id,
        scope: "project",
      });
    }
  }

  public async pauseAllRunningProjects(reason?: string): Promise<void> {
    for (const project of listProjects(this.context)) {
      if (project.status !== "active") {
        continue;
      }

      await this.pauseProject(project.id, reason);
    }
  }

  public reconcileExecutionStates(): boolean {
    let changed = false;

    for (const project of listProjects(this.context)) {
      const executionState = resolveProjectExecutionState(this.context, project.id);
      const metadata = parseProjectMetadata(project);

      if (metadata.executionState === executionState) {
        continue;
      }

      updateProjectMetadata(this.context, {
        executionState,
        projectId: project.id,
      });
      changed = true;
    }

    return changed;
  }

  private requireProject(projectId: string): IProjectRecord {
    const project = getProjectById(this.context, projectId);

    if (project === null) {
      throw new Error(`Missing project ${projectId}`);
    }

    return project;
  }
}

export function resolveProjectExecutionState(
  context: IStorageContext,
  projectId: string,
): ProjectExecutionState {
  const project = getProjectById(context, projectId);

  if (project === null) {
    throw new Error(`Missing project ${projectId}`);
  }

  if (project.status !== "active") {
    return "paused";
  }

  const metadata = parseProjectMetadata(project);

  if (metadata.executionState === "waiting_for_credit") {
    return "waiting_for_credit";
  }

  const openBlockers = listBlockersForProject(context, projectId).filter((blocker) => {
    return blocker.status === "open";
  });
  const pendingApprovals = listApprovalsForProject(context, projectId).filter((approval) => {
    return approval.status === "pending";
  });

  if (hasWaitingForHumanState(openBlockers, pendingApprovals)) {
    return "waiting_for_human";
  }

  if (hasBlockedState(openBlockers)) {
    return "blocked";
  }

  return "active";
}

function hasWaitingForHumanState(
  openBlockers: readonly IBlockerRecord[],
  pendingApprovals: readonly IApprovalRecord[],
): boolean {
  return (
    pendingApprovals.length > 0 ||
    openBlockers.some((blocker) => {
      return blocker.blockerType === "human" || blocker.blockerType === "policy";
    })
  );
}

function hasBlockedState(openBlockers: readonly IBlockerRecord[]): boolean {
  return openBlockers.some((blocker) => {
    return ["helper_model", "system"].includes(blocker.blockerType);
  });
}

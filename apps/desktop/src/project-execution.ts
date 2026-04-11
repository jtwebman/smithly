import type { IProjectRecord } from "@smithly/core";
import {
  getProjectById,
  listProjects,
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

  private requireProject(projectId: string): IProjectRecord {
    const project = getProjectById(this.context, projectId);

    if (project === null) {
      throw new Error(`Missing project ${projectId}`);
    }

    return project;
  }
}

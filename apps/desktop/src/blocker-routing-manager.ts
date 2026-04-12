import { randomUUID } from "node:crypto";

import {
  getProjectById,
  listBlockersForProject,
  listProjects,
  parseProjectMetadata,
  upsertBlocker,
  upsertMemoryNote,
  type IStorageContext,
} from "@smithly/storage";

export interface IBlockerRoutingManagerOptions {
  readonly now?: () => Date;
  readonly onUpdated?: () => void;
}

export class BlockerRoutingManager {
  private readonly now: () => Date;
  private readonly onUpdated: () => void;

  public constructor(
    private readonly context: IStorageContext,
    options: IBlockerRoutingManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onUpdated = options.onUpdated ?? (() => undefined);
  }

  public processOpenBlockers(): void {
    for (const project of listProjects(this.context)) {
      for (const blocker of listBlockersForProject(this.context, project.id)) {
        if (blocker.status !== "open") {
          continue;
        }

        const classifiedType = classifyBlocker(
          blocker.title,
          blocker.detail,
          blocker.blockerType,
        );

        if (blocker.blockerType !== classifiedType) {
          upsertBlocker(this.context, {
            ...blocker,
            blockerType: classifiedType,
            updatedAt: this.now().toISOString(),
          });
        }

        if (classifiedType !== "helper_model") {
          continue;
        }

        const resolutionNote = answerHelperBlocker(this.context, project.id, blocker.detail);
        const timestamp = this.now().toISOString();

        upsertBlocker(this.context, {
          ...blocker,
          blockerType: classifiedType,
          resolutionNote,
          resolvedAt: timestamp,
          status: "resolved",
          updatedAt: timestamp,
        });
        upsertMemoryNote(this.context, {
          ...(blocker.backlogItemId !== undefined ? { backlogItemId: blocker.backlogItemId } : {}),
          bodyText: resolutionNote,
          createdAt: timestamp,
          id: `memory-helper-blocker-${blocker.id}-${randomUUID()}`,
          noteType: "note",
          projectId: blocker.projectId,
          ...(blocker.taskRunId !== undefined ? { taskRunId: blocker.taskRunId } : {}),
          title: "Helper blocker answer",
          updatedAt: timestamp,
        });
        this.onUpdated();
      }
    }
  }
}

export function classifyBlocker(
  title: string,
  detail: string,
  existingType?: "policy" | "helper_model" | "human" | "system",
): "policy" | "helper_model" | "human" | "system" {
  if (existingType === "system") {
    return "system";
  }

  const normalizedText = `${title}\n${detail}`.toLowerCase();

  if (
    /(approval|policy|permission|allowed|forbidden|review required|compliance|security exception)/.test(
      normalizedText,
    )
  ) {
    return "policy";
  }

  if (
    /(what command|which command|where is|path|repo path|file|branch|test command|verification|lint|format|log file|history|status|how do i)/.test(
      normalizedText,
    )
  ) {
    return "helper_model";
  }

  return "human";
}

export function answerHelperBlocker(
  context: IStorageContext,
  projectId: string,
  detail: string,
): string {
  const project = getProjectById(context, projectId);

  if (project === null) {
    return "Helper routing could not load the project context.";
  }

  const normalizedDetail = detail.toLowerCase();
  const metadata = parseProjectMetadata(project);

  if (/(verification|test command|lint|format)/.test(normalizedDetail)) {
    return metadata.verificationCommands.length > 0
      ? `Use the configured verification commands for this project: ${metadata.verificationCommands.join(" | ")}.`
      : "This project does not have verification commands configured yet.";
  }

  if (/(repo path|where is|path|file)/.test(normalizedDetail)) {
    return `The managed repository path for this project is ${project.repoPath}.`;
  }

  if (/(branch|default branch)/.test(normalizedDetail)) {
    return `The current default branch is ${project.defaultBranch ?? "not recorded yet"}.`;
  }

  if (/(log file|history|transcript)/.test(normalizedDetail)) {
    return "Worker transcripts are stored in the Smithly data directory under worker-logs.";
  }

  return "Smithly can answer low-risk operational questions from stored project metadata, logs, and verification settings.";
}

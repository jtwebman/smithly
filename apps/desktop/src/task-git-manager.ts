import { spawnSync, type SpawnSyncReturns } from "node:child_process";

import type { IMemoryNoteRecord, ITaskRunRecord, IProjectRecord } from "@smithly/core";
import {
  getBacklogItemById,
  getProjectById,
  listMemoryNotesForProject,
  listProjects,
  listTaskRunsForProject,
  updateProjectMetadata,
  upsertMemoryNote,
  type IStorageContext,
} from "@smithly/storage";

export interface ITaskGitState {
  readonly branchName: string;
  readonly defaultBranch: string;
  readonly pauseCommitCreated: boolean;
  readonly pullRequestUrl?: string;
  readonly status: "branch_prepared" | "paused" | "pr_opened";
  readonly updatedAt: string;
}

export interface ITaskGitManagerOptions {
  readonly now?: () => Date;
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => ITaskGitCommandResult;
}

export interface ITaskGitCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export class TaskGitManager {
  private readonly now: () => Date;
  private readonly runCommand: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => ITaskGitCommandResult;

  public constructor(
    private readonly context: IStorageContext,
    options: ITaskGitManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.runCommand = options.runCommand ?? runCommand;
  }

  public ensureTaskBranch(taskRunId: string): ITaskGitState {
    const existingState = this.getTaskGitState(taskRunId);

    if (existingState !== null) {
      return existingState;
    }

    return this.prepareTaskBranch(taskRunId);
  }

  public prepareTaskBranch(taskRunId: string): ITaskGitState {
    const taskRun = this.requireTaskRun(taskRunId);
    const project = this.requireProject(taskRun.projectId);
    const backlogItem = getBacklogItemById(this.context, taskRun.backlogItemId);

    if (backlogItem === null) {
      throw new Error(`Missing backlog item ${taskRun.backlogItemId}`);
    }

    const defaultBranch = this.resolveDefaultBranch(project);
    const branchName = formatTaskBranchName(taskRun.id, backlogItem.title);

    this.execGit(project.repoPath, ["checkout", defaultBranch]);
    this.execGit(project.repoPath, ["checkout", "-B", branchName, defaultBranch]);

    return this.writeTaskGitState(taskRun, {
      branchName,
      defaultBranch,
      pauseCommitCreated: false,
      status: "branch_prepared",
      updatedAt: this.now().toISOString(),
    });
  }

  public pauseTaskBranch(taskRunId: string): ITaskGitState {
    const taskRun = this.requireTaskRun(taskRunId);
    const project = this.requireProject(taskRun.projectId);
    const state = this.ensureTaskBranch(taskRunId);

    this.execGit(project.repoPath, ["checkout", state.branchName]);

    const hasWorkingTreeChanges =
      this.execGit(project.repoPath, ["status", "--porcelain"]).stdout.trim().length > 0;

    if (hasWorkingTreeChanges) {
      this.execGit(project.repoPath, ["add", "-A"]);
      this.execGit(project.repoPath, ["commit", "--no-verify", "-m", `WIP: pause ${taskRun.id}`]);
    }

    this.execGit(project.repoPath, ["checkout", state.defaultBranch]);

    return this.writeTaskGitState(taskRun, {
      ...state,
      pauseCommitCreated: hasWorkingTreeChanges,
      status: "paused",
      updatedAt: this.now().toISOString(),
    });
  }

  public openPullRequest(taskRunId: string): ITaskGitState {
    const taskRun = this.requireTaskRun(taskRunId);
    const project = this.requireProject(taskRun.projectId);
    const backlogItem = getBacklogItemById(this.context, taskRun.backlogItemId);

    if (backlogItem === null) {
      throw new Error(`Missing backlog item ${taskRun.backlogItemId}`);
    }

    const state = this.ensureTaskBranch(taskRunId);

    this.execGit(project.repoPath, ["push", "-u", "origin", state.branchName]);

    const existingPullRequestUrl = state.pullRequestUrl;
    let pullRequestUrl = existingPullRequestUrl;

    if (pullRequestUrl === undefined) {
      try {
        pullRequestUrl = this.execCommand(
          "gh",
          [
            "pr",
            "create",
            "--base",
            state.defaultBranch,
            "--head",
            state.branchName,
            "--title",
            backlogItem.title,
            "--body",
            taskRun.summaryText ?? `Smithly completed ${backlogItem.title}.`,
          ],
          project.repoPath,
        ).stdout.trim();
      } catch {
        pullRequestUrl = this.execCommand(
          "gh",
          ["pr", "view", "--json", "url", "--head", state.branchName, "--jq", ".url"],
          project.repoPath,
        ).stdout.trim();
      }
    }

    return this.writeTaskGitState(taskRun, {
      ...state,
      ...(pullRequestUrl.length > 0 ? { pullRequestUrl } : {}),
      status: "pr_opened",
      updatedAt: this.now().toISOString(),
    });
  }

  public getTaskGitState(taskRunId: string): ITaskGitState | null {
    const taskRun = this.requireTaskRun(taskRunId);
    const note = listMemoryNotesForProject(this.context, taskRun.projectId).find((candidate) => {
      return candidate.id === buildTaskGitNoteId(taskRun.id);
    });

    if (note === undefined) {
      return null;
    }

    return parseTaskGitState(note.bodyText);
  }

  private resolveDefaultBranch(project: IProjectRecord): string {
    const configuredDefaultBranch = project.defaultBranch?.trim();

    if (configuredDefaultBranch) {
      return configuredDefaultBranch;
    }

    const originHead = this.execGit(project.repoPath, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]).stdout.trim();
    const detectedDefaultBranch =
      originHead.split("/").at(-1)?.trim() ||
      this.execGit(project.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() ||
      "main";

    updateProjectMetadata(this.context, {
      defaultBranch: detectedDefaultBranch,
      projectId: project.id,
    });

    return detectedDefaultBranch;
  }

  private execGit(repoPath: string, args: readonly string[]): ITaskGitCommandResult {
    return this.execCommand("git", args, repoPath);
  }

  private execCommand(
    command: string,
    args: readonly string[],
    repoPath: string,
  ): ITaskGitCommandResult {
    const result = this.runCommand(command, args, repoPath);

    if (result.exitCode !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed in ${repoPath}: ${result.stderr || result.stdout}`,
      );
    }

    return result;
  }

  private writeTaskGitState(taskRun: ITaskRunRecord, state: ITaskGitState): ITaskGitState {
    const existingNote = listMemoryNotesForProject(this.context, taskRun.projectId).find(
      (candidate) => {
        return candidate.id === buildTaskGitNoteId(taskRun.id);
      },
    );
    const note: IMemoryNoteRecord = {
      backlogItemId: taskRun.backlogItemId,
      bodyText: serializeTaskGitState(state),
      createdAt: existingNote?.createdAt ?? state.updatedAt,
      id: buildTaskGitNoteId(taskRun.id),
      noteType: "note",
      projectId: taskRun.projectId,
      taskRunId: taskRun.id,
      title: "Task git lifecycle",
      updatedAt: state.updatedAt,
    };

    upsertMemoryNote(this.context, note);
    return state;
  }

  private requireTaskRun(taskRunId: string): ITaskRunRecord {
    for (const project of listProjects(this.context)) {
      const taskRun = listTaskRunsForProject(this.context, project.id).find((candidate) => {
        return candidate.id === taskRunId;
      });

      if (taskRun !== undefined) {
        return taskRun;
      }
    }

    throw new Error(`Missing task run ${taskRunId}`);
  }

  private requireProject(projectId: string): IProjectRecord {
    const project = getProjectById(this.context, projectId);

    if (project === null) {
      throw new Error(`Missing project ${projectId}`);
    }

    return project;
  }
}

export function formatTaskBranchName(taskRunId: string, title: string): string {
  const taskIdTail = taskRunId.split("-").at(-1)?.slice(0, 12) || taskRunId.slice(-12);
  const slug = slugify(title).slice(0, 48) || "task";

  return `smithly-${taskIdTail}-${slug}`;
}

export function parseTaskGitState(bodyText: string): ITaskGitState {
  const parsedEntries = Object.fromEntries(
    bodyText
      .split("\n")
      .map((line) => line.split(/:\s+/, 2))
      .filter((entry) => entry.length === 2),
  );

  const status = parsedEntries.status;
  const branchName = parsedEntries.branchName;
  const defaultBranch = parsedEntries.defaultBranch;
  const updatedAt = parsedEntries.updatedAt;

  if (
    typeof status !== "string" ||
    !["branch_prepared", "paused", "pr_opened"].includes(status) ||
    typeof branchName !== "string" ||
    typeof defaultBranch !== "string" ||
    typeof updatedAt !== "string"
  ) {
    throw new Error("Invalid task git state note.");
  }

  return {
    branchName,
    defaultBranch,
    pauseCommitCreated: parsedEntries.pauseCommitCreated === "true",
    ...(typeof parsedEntries.pullRequestUrl === "string"
      ? { pullRequestUrl: parsedEntries.pullRequestUrl }
      : {}),
    status: status as ITaskGitState["status"],
    updatedAt,
  };
}

function buildTaskGitNoteId(taskRunId: string): string {
  return `memory-task-git-${taskRunId}`;
}

function serializeTaskGitState(state: ITaskGitState): string {
  return [
    `status: ${state.status}`,
    `branchName: ${state.branchName}`,
    `defaultBranch: ${state.defaultBranch}`,
    `pauseCommitCreated: ${String(state.pauseCommitCreated)}`,
    ...(state.pullRequestUrl !== undefined ? [`pullRequestUrl: ${state.pullRequestUrl}`] : []),
    `updatedAt: ${state.updatedAt}`,
  ].join("\n");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .replaceAll(/--+/g, "-");
}

function runCommand(command: string, args: readonly string[], cwd: string): ITaskGitCommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });

  return normalizeSpawnResult(result);
}

function normalizeSpawnResult(result: SpawnSyncReturns<string>): ITaskGitCommandResult {
  if (result.error !== undefined) {
    return {
      exitCode: result.status ?? 1,
      stderr: result.error.message,
      stdout: result.stdout ?? "",
    };
  }

  return {
    exitCode: result.status ?? 0,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

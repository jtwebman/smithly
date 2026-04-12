import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfig } from "@smithly/core";
import {
  addBacklogDependency,
  createContext,
  createDraftBacklogItemFromPlanning,
  createInitialSeedFixture,
  getBacklogItemById,
  listBlockersForProject,
  listReviewRunsForTask,
  listTaskRunsForProject,
  reviseBacklogItemFromPlanning,
  seedInitialState,
  startCodingTask,
  upsertBacklogItem,
  upsertMemoryNote,
  upsertTaskRun,
} from "@smithly/storage";

import { ReviewManager } from "./review-manager.ts";
import {
  queueRequiredReviewRun,
  reconcileTaskReviewState,
  updateReviewRunDecision,
} from "./task-review-policy.ts";
import { TaskMergeManager } from "./task-merge-manager.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("task review policy", () => {
  it("holds human-reviewed tasks until the operator approves them", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-review-policy-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-review-policy-repo-"));

    temporaryDirectories.push(dataDirectory, repoPath);
    mkdirSync(join(repoPath, ".git"));

    const fixture = createInitialSeedFixture();
    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    seedInitialState(context, {
      ...fixture,
      project: {
        ...fixture.project,
        metadataJson:
          '{"metadata":{},"verificationCommands":[],"approvalPolicy":{"requireApprovalForNewBacklogItems":true,"requireApprovalForScopeChanges":true,"requireApprovalForHighRiskTasks":true}}',
        repoPath,
      },
    });
    const backlogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Hold this task for operator review.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Human reviewed task",
    });

    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["Operator approval decides final done state."],
      backlogItemId: backlogItem.id,
      readiness: "ready",
      reviewMode: "human",
      scopeSummary: "Hold this task for operator review.",
      status: "approved",
    });

    const taskRun = startCodingTask(context, {
      backlogItemId: backlogItem.id,
      assignedWorker: "codex",
    });
    const timestamp = "2026-04-10T13:00:00.000Z";

    upsertTaskRun(context, {
      ...taskRun,
      completedAt: timestamp,
      status: "done",
      updatedAt: timestamp,
    });
    queueRequiredReviewRun(
      context,
      {
        ...taskRun,
        completedAt: timestamp,
        status: "done",
        updatedAt: timestamp,
      },
      timestamp,
    );
    reconcileTaskReviewState(context, taskRun.id, timestamp);
    writeTaskGitState(context, fixture.project.id, taskRun.id, {
      branchName: "smithly-human-reviewed-task",
      defaultBranch: "main",
      pauseCommitCreated: false,
      pullRequestUrl: "https://github.com/jtwebman/smithly/pull/101",
      status: "pr_opened",
      updatedAt: timestamp,
    });

    expect(
      listTaskRunsForProject(context, fixture.project.id).find(
        (candidate) => candidate.id === taskRun.id,
      )?.status,
    ).toBe("awaiting_review");

    const reviewRun = listReviewRunsForTask(context, taskRun.id).find((candidate) => {
      return candidate.reviewerKind === "human";
    });

    expect(reviewRun?.status).toBe("queued");

    updateReviewRunDecision(
      context,
      reviewRun?.id ?? "",
      "approved",
      "2026-04-10T13:05:00.000Z",
      "Operator approved the task.",
    );

    expect(
      listTaskRunsForProject(context, fixture.project.id).find(
        (candidate) => candidate.id === taskRun.id,
      )?.status,
    ).toBe("awaiting_review");

    writeTaskGitState(context, fixture.project.id, taskRun.id, {
      branchName: "smithly-human-reviewed-task",
      defaultBranch: "main",
      pauseCommitCreated: false,
      pullRequestUrl: "https://github.com/jtwebman/smithly/pull/101",
      status: "merged",
      updatedAt: "2026-04-10T13:06:00.000Z",
    });
    reconcileTaskReviewState(context, taskRun.id, "2026-04-10T13:06:00.000Z");

    expect(
      listTaskRunsForProject(context, fixture.project.id).find(
        (candidate) => candidate.id === taskRun.id,
      )?.status,
    ).toBe("done");
    expect(getBacklogItemById(context, backlogItem.id)?.status).toBe("done");

    context.db.close();
  });

  it("automatically completes queued ai peer reviews", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-ai-review-policy-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-ai-review-policy-repo-"));

    temporaryDirectories.push(dataDirectory, repoPath);
    mkdirSync(join(repoPath, ".git"));

    const fixture = createInitialSeedFixture();
    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    seedInitialState(context, {
      ...fixture,
      project: {
        ...fixture.project,
        metadataJson:
          '{"metadata":{},"verificationCommands":[],"approvalPolicy":{"requireApprovalForNewBacklogItems":true,"requireApprovalForScopeChanges":true,"requireApprovalForHighRiskTasks":true}}',
        repoPath,
      },
    });
    const backlogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Use ai review for this task.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "AI reviewed task",
    });

    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["Peer review completes automatically."],
      backlogItemId: backlogItem.id,
      readiness: "ready",
      reviewMode: "ai",
      scopeSummary: "Use ai review for this task.",
      status: "approved",
    });

    const taskRun = startCodingTask(context, {
      backlogItemId: backlogItem.id,
      assignedWorker: "codex",
    });
    const timestamp = "2026-04-10T14:00:00.000Z";

    upsertTaskRun(context, {
      ...taskRun,
      completedAt: timestamp,
      status: "done",
      updatedAt: timestamp,
    });
    queueRequiredReviewRun(
      context,
      {
        ...taskRun,
        completedAt: timestamp,
        status: "done",
        updatedAt: timestamp,
      },
      timestamp,
    );
    reconcileTaskReviewState(context, taskRun.id, timestamp);
    writeTaskGitState(context, fixture.project.id, taskRun.id, {
      branchName: "smithly-ai-reviewed-task",
      defaultBranch: "main",
      pauseCommitCreated: false,
      pullRequestUrl: "https://github.com/jtwebman/smithly/pull/102",
      status: "pr_opened",
      updatedAt: timestamp,
    });

    const mergeManager = {
      mergeTaskRun: vi.fn((taskRunId: string) => {
        writeTaskGitState(context, fixture.project.id, taskRunId, {
          branchName: "smithly-ai-reviewed-task",
          defaultBranch: "main",
          pauseCommitCreated: false,
          pullRequestUrl: "https://github.com/jtwebman/smithly/pull/102",
          status: "merged",
          updatedAt: "2026-04-10T14:05:00.000Z",
        });
      }),
      syncDependentBlockers: vi.fn(),
    } as unknown as TaskMergeManager;
    const manager = new ReviewManager(context, {
      mergeManager,
      now: () => new Date("2026-04-10T14:05:00.000Z"),
    });
    manager.processQueuedRuns();

    const reviewRun = listReviewRunsForTask(context, taskRun.id).find((candidate) => {
      return candidate.reviewerKind === "claude";
    });

    expect(reviewRun?.status).toBe("approved");
    expect(
      listTaskRunsForProject(context, fixture.project.id).find(
        (candidate) => candidate.id === taskRun.id,
      )?.status,
    ).toBe("done");
    expect(getBacklogItemById(context, backlogItem.id)?.status).toBe("done");
    expect(mergeManager.mergeTaskRun).toHaveBeenCalledWith(taskRun.id);

    context.db.close();
  });

  it("blocks dependent backlog items until a parent task pull request is merged", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-merge-block-policy-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-merge-block-repo-"));

    temporaryDirectories.push(dataDirectory, repoPath);
    mkdirSync(join(repoPath, ".git"));

    const fixture = createInitialSeedFixture();
    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    seedInitialState(context, {
      ...fixture,
      project: {
        ...fixture.project,
        metadataJson:
          '{"metadata":{},"verificationCommands":[],"approvalPolicy":{"requireApprovalForNewBacklogItems":true,"requireApprovalForScopeChanges":true,"requireApprovalForHighRiskTasks":true}}',
        repoPath,
      },
    });
    const parentBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Parent work must merge before children proceed.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Parent merged task",
    });
    const childBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Child work depends on the parent merge.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Child follow-up task",
    });

    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["Parent task must merge first."],
      backlogItemId: parentBacklogItem.id,
      readiness: "ready",
      reviewMode: "human",
      scopeSummary: "Parent work must merge before children proceed.",
      status: "approved",
    });
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["Wait until the parent pull request merges."],
      backlogItemId: childBacklogItem.id,
      readiness: "ready",
      scopeSummary: "Child work depends on the parent merge.",
      status: "approved",
    });
    addBacklogDependency(context, {
      blockedBacklogItemId: childBacklogItem.id,
      blockingBacklogItemId: parentBacklogItem.id,
    });

    const parentTaskRun = startCodingTask(context, {
      backlogItemId: parentBacklogItem.id,
      assignedWorker: "codex",
    });
    const timestamp = "2026-04-10T15:00:00.000Z";

    upsertTaskRun(context, {
      ...parentTaskRun,
      completedAt: timestamp,
      status: "done",
      updatedAt: timestamp,
    });
    queueRequiredReviewRun(
      context,
      {
        ...parentTaskRun,
        completedAt: timestamp,
        status: "done",
        updatedAt: timestamp,
      },
      timestamp,
    );
    writeTaskGitState(context, fixture.project.id, parentTaskRun.id, {
      branchName: "smithly-parent-merged-task",
      defaultBranch: "main",
      pauseCommitCreated: false,
      pullRequestUrl: "https://github.com/jtwebman/smithly/pull/103",
      status: "pr_opened",
      updatedAt: timestamp,
    });
    reconcileTaskReviewState(context, parentTaskRun.id, timestamp);

    expect(listBlockersForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backlogItemId: childBacklogItem.id,
          status: "open",
          title: "Waiting for parent task merge",
        }),
      ]),
    );

    writeTaskGitState(context, fixture.project.id, parentTaskRun.id, {
      branchName: "smithly-parent-merged-task",
      defaultBranch: "main",
      pauseCommitCreated: false,
      pullRequestUrl: "https://github.com/jtwebman/smithly/pull/103",
      status: "merged",
      updatedAt: "2026-04-10T15:10:00.000Z",
    });
    reconcileTaskReviewState(context, parentTaskRun.id, "2026-04-10T15:10:00.000Z");

    expect(listBlockersForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backlogItemId: childBacklogItem.id,
          status: "resolved",
          title: "Waiting for parent task merge",
        }),
      ]),
    );

    context.db.close();
  });
});

function writeTaskGitState(
  context: ReturnType<typeof createContext>,
  projectId: string,
  taskRunId: string,
  state: {
    readonly branchName: string;
    readonly defaultBranch: string;
    readonly pauseCommitCreated: boolean;
    readonly pullRequestUrl?: string;
    readonly status: "branch_prepared" | "paused" | "pr_opened" | "merged";
    readonly updatedAt: string;
  },
): void {
  upsertMemoryNote(context, {
    bodyText: [
      `status: ${state.status}`,
      `branchName: ${state.branchName}`,
      `defaultBranch: ${state.defaultBranch}`,
      `pauseCommitCreated: ${String(state.pauseCommitCreated)}`,
      ...(state.pullRequestUrl !== undefined ? [`pullRequestUrl: ${state.pullRequestUrl}`] : []),
      `updatedAt: ${state.updatedAt}`,
    ].join("\n"),
    createdAt: state.updatedAt,
    id: `memory-task-git-${taskRunId}`,
    noteType: "note",
    projectId,
    taskRunId,
    title: "Task git lifecycle",
    updatedAt: state.updatedAt,
  });
}

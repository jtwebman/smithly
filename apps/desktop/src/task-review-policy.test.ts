import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createDraftBacklogItemFromPlanning,
  createInitialSeedFixture,
  getBacklogItemById,
  listReviewRunsForTask,
  listTaskRunsForProject,
  reviseBacklogItemFromPlanning,
  seedInitialState,
  startCodingTask,
  upsertTaskRun,
} from "@smithly/storage";

import { ReviewManager } from "./review-manager.ts";
import {
  queueRequiredReviewRun,
  reconcileTaskReviewState,
  updateReviewRunDecision,
} from "./task-review-policy.ts";

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

    const manager = new ReviewManager(context, {
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

    context.db.close();
  });
});

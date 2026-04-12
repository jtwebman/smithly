import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createDraftBacklogItemFromPlanning,
  createContext,
  createInitialSeedFixture,
  getBacklogItemById,
  listMemoryNotesForProject,
  listReviewRunsForTask,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  listWorkerSessionsForProject,
  reviseBacklogItemFromPlanning,
  seedInitialState,
} from "@smithly/storage";

import { CodexSessionManager } from "./codex-session.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("CodexSessionManager", () => {
  it("starts codex task sessions with transcript refs and structured outcome hooks", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-codex-session-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-codex-repo-"));

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
        repoPath,
      },
    });
    const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Use a fresh backlog item for Codex session startup.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Fresh Codex session task",
    });
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["The task is approved and ready for execution."],
      backlogItemId: createdBacklogItem.id,
      readiness: "ready",
      scopeSummary: "Use a fresh backlog item for Codex session startup.",
      status: "approved",
    });

    const fakePty = createFakePty();
    const fakeTaskGitManager = createFakeTaskGitManager();
    const manager = new CodexSessionManager(context, () => undefined, {
      now: () => new Date("2026-04-10T10:00:00.000Z"),
      spawnPty: () => fakePty,
      taskGitManager: fakeTaskGitManager,
    });

    const taskRun = manager.startSession({
      backlogItemId: createdBacklogItem.id,
      projectId: fixture.project.id,
      summaryText: "Start Codex implementation for the selected backlog item.",
    });

    const codexSession = listWorkerSessionsForProject(context, fixture.project.id).find(
      (session) => {
        return session.workerKind === "codex" && session.id !== fixture.workerSession.id;
      },
    );

    expect(taskRun.status).toBe("queued");
    expect(getBacklogItemById(context, createdBacklogItem.id)?.status).toBe("in_progress");
    expect(codexSession?.status).toBe("running");
    expect(codexSession?.transcriptRef).toContain(`task-run:${taskRun.id}`);
    expect(codexSession?.transcriptRef).toContain("|log-file:");
    expect(fakeTaskGitManager.ensureTaskBranch).toHaveBeenCalledWith(taskRun.id);

    fakePty.emitData(
      `smithly-hook: ${JSON.stringify({
        payload: {
          id: taskRun.id,
          status: "done",
          summaryText: "Implemented the requested task.",
        },
        type: "task_outcome",
      })}\n`,
    );
    fakePty.emitExit(0);

    const completedTaskRun = listTaskRunsForProject(context, fixture.project.id).find(
      (candidate) => {
        return candidate.id === taskRun.id;
      },
    );
    const summaryNote = listMemoryNotesForProject(context, fixture.project.id).find((note) => {
      return note.id === `memory-session-summary-${codexSession?.id}`;
    });
    const completionNote = listMemoryNotesForProject(context, fixture.project.id).find((note) => {
      return note.id === `memory-codex-complete-${taskRun.id}`;
    });
    const logFilePath = codexSession?.transcriptRef?.split("|log-file:")[1];

    expect(completedTaskRun?.status).toBe("awaiting_review");
    expect(completedTaskRun?.summaryText).toBe("Implemented the requested task.");
    expect(getBacklogItemById(context, createdBacklogItem.id)?.status).toBe("in_progress");
    expect(summaryNote?.bodyText).toContain("worker: codex");
    expect(summaryNote?.bodyText).toContain(`taskRunId: ${taskRun.id}`);
    expect(completionNote?.title).toBe("Codex task completed");
    expect(listReviewRunsForTask(context, taskRun.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewerKind: "human",
          status: "queued",
        }),
      ]),
    );
    expect(listVerificationRunsForTask(context, taskRun.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandText: "npm run check",
          status: "queued",
        }),
      ]),
    );
    expect(readFileSync(logFilePath ?? "", "utf8")).toContain('status":"done"');
    expect(fakeTaskGitManager.openPullRequest).toHaveBeenCalledWith(taskRun.id);

    manager.dispose();
    context.db.close();
  });

  it("marks codex task runs failed when the worker exits non-zero", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-codex-session-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-codex-repo-"));

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
        repoPath,
      },
    });
    const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Exercise the Codex failure path.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Failing Codex session task",
    });
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["The task is approved and ready for execution."],
      backlogItemId: createdBacklogItem.id,
      readiness: "ready",
      scopeSummary: "Exercise the Codex failure path.",
      status: "approved",
    });

    const fakePty = createFakePty();
    const fakeTaskGitManager = createFakeTaskGitManager();
    const manager = new CodexSessionManager(context, () => undefined, {
      now: () => new Date("2026-04-10T10:30:00.000Z"),
      spawnPty: () => fakePty,
      taskGitManager: fakeTaskGitManager,
    });

    const taskRun = manager.startSession({
      backlogItemId: createdBacklogItem.id,
      projectId: fixture.project.id,
    });

    fakePty.emitExit(1);

    expect(
      listTaskRunsForProject(context, fixture.project.id).find(
        (candidate) => candidate.id === taskRun.id,
      )?.status,
    ).toBe("failed");
    expect(
      listWorkerSessionsForProject(context, fixture.project.id).find((session) => {
        return session.transcriptRef?.startsWith(`task-run:${taskRun.id}`);
      })?.status,
    ).toBe("failed");

    manager.dispose();
    context.db.close();
  });

  it("preserves cancelled codex task outcomes when the session later exits cleanly", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-codex-session-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-codex-repo-"));

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
        repoPath,
      },
    });
    const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Exercise the Codex cancellation path.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Cancelled Codex session task",
    });
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["The task is approved and ready for execution."],
      backlogItemId: createdBacklogItem.id,
      readiness: "ready",
      scopeSummary: "Exercise the Codex cancellation path.",
      status: "approved",
    });

    const fakePty = createFakePty();
    const fakeTaskGitManager = createFakeTaskGitManager();
    const manager = new CodexSessionManager(context, () => undefined, {
      now: () => new Date("2026-04-10T11:00:00.000Z"),
      spawnPty: () => fakePty,
      taskGitManager: fakeTaskGitManager,
    });

    const taskRun = manager.startSession({
      backlogItemId: createdBacklogItem.id,
      projectId: fixture.project.id,
    });

    fakePty.emitData(
      `smithly-hook: ${JSON.stringify({
        payload: {
          id: taskRun.id,
          status: "cancelled",
          summaryText: "Cancelled after operator reprioritized the task.",
        },
        type: "task_outcome",
      })}\n`,
    );
    fakePty.emitExit(0);

    const cancelledTaskRun = listTaskRunsForProject(context, fixture.project.id).find(
      (candidate) => {
        return candidate.id === taskRun.id;
      },
    );

    expect(cancelledTaskRun?.status).toBe("cancelled");
    expect(cancelledTaskRun?.summaryText).toBe("Cancelled after operator reprioritized the task.");

    manager.dispose();
    context.db.close();
  });

  it("requests codex task pauses and hands WIP persistence to the git manager", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-codex-session-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-codex-repo-"));

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
        repoPath,
      },
    });
    const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Exercise the Codex pause path.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Paused Codex session task",
    });
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["The task is approved and ready for execution."],
      backlogItemId: createdBacklogItem.id,
      readiness: "ready",
      scopeSummary: "Exercise the Codex pause path.",
      status: "approved",
    });

    const fakePty = createFakePty();
    const fakeTaskGitManager = createFakeTaskGitManager();
    const manager = new CodexSessionManager(context, () => undefined, {
      now: () => new Date("2026-04-10T11:30:00.000Z"),
      spawnPty: () => fakePty,
      taskGitManager: fakeTaskGitManager,
    });

    const taskRun = manager.startSession({
      backlogItemId: createdBacklogItem.id,
      projectId: fixture.project.id,
    });

    const pausePromise = manager.requestProjectPause(
      fixture.project.id,
      "Operator paused the project from the desktop controls.",
    );

    expect(fakePty.writes.at(-1)).toContain("/pause Operator paused the project");

    fakePty.emitExit(0);
    await pausePromise;

    expect(fakeTaskGitManager.pauseTaskBranch).toHaveBeenCalledWith(taskRun.id);
    expect(
      listTaskRunsForProject(context, fixture.project.id).find(
        (candidate) => candidate.id === taskRun.id,
      )?.status,
    ).toBe("queued");

    manager.dispose();
    context.db.close();
  });
});

function createFakePty(): IFakePty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  const writes: string[] = [];

  return {
    kill() {
      return undefined;
    },
    onData(listener: (data: string) => void) {
      dataListeners.push(listener);
      return undefined;
    },
    onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
      exitListeners.push(listener);
      return undefined;
    },
    resize() {
      return undefined;
    },
    write(data: string) {
      writes.push(data);
      return undefined;
    },
    emitData(data: string) {
      for (const listener of dataListeners) {
        listener(data);
      }
    },
    emitExit(exitCode: number) {
      for (const listener of exitListeners) {
        listener({ exitCode });
      }
    },
    writes,
  } as unknown as IFakePty;
}

interface IFakePty extends IPty {
  emitData(data: string): void;
  emitExit(exitCode: number): void;
  readonly writes: readonly string[];
}

function createFakeTaskGitManager() {
  return {
    ensureTaskBranch: vi.fn((taskRunId: string) => ({
      branchName: `smithly-${taskRunId}-task`,
      defaultBranch: "main",
      pauseCommitCreated: false,
      status: "branch_prepared",
      updatedAt: "2026-04-10T10:00:00.000Z",
    })),
    openPullRequest: vi.fn((taskRunId: string) => ({
      branchName: `smithly-${taskRunId}-task`,
      defaultBranch: "main",
      pauseCommitCreated: false,
      pullRequestUrl: `https://github.com/jtwebman/smithly/pull/${taskRunId}`,
      status: "pr_opened",
      updatedAt: "2026-04-10T10:05:00.000Z",
    })),
    pauseTaskBranch: vi.fn((taskRunId: string) => ({
      branchName: `smithly-${taskRunId}-task`,
      defaultBranch: "main",
      pauseCommitCreated: true,
      status: "paused",
      updatedAt: "2026-04-10T11:30:00.000Z",
    })),
  } as unknown as import("./task-git-manager.ts").TaskGitManager;
}

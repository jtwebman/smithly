import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IPty } from "node-pty";
import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createDraftBacklogItemFromPlanning,
  createContext,
  createInitialSeedFixture,
  getBacklogItemById,
  listMemoryNotesForProject,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  listWorkerSessionsForProject,
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

    const fakePty = createFakePty();
    const manager = new CodexSessionManager(context, () => undefined, {
      now: () => new Date("2026-04-10T10:00:00.000Z"),
      spawnPty: () => fakePty,
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

    expect(completedTaskRun?.status).toBe("done");
    expect(completedTaskRun?.summaryText).toBe("Implemented the requested task.");
    expect(summaryNote?.bodyText).toContain("worker: codex");
    expect(summaryNote?.bodyText).toContain(`taskRunId: ${taskRun.id}`);
    expect(completionNote?.title).toBe("Codex task completed");
    expect(listVerificationRunsForTask(context, taskRun.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandText: "npm run check",
          status: "queued",
        }),
      ]),
    );
    expect(readFileSync(logFilePath ?? "", "utf8")).toContain('status":"done"');

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

    const fakePty = createFakePty();
    const manager = new CodexSessionManager(context, () => undefined, {
      now: () => new Date("2026-04-10T10:30:00.000Z"),
      spawnPty: () => fakePty,
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

    const fakePty = createFakePty();
    const manager = new CodexSessionManager(context, () => undefined, {
      now: () => new Date("2026-04-10T11:00:00.000Z"),
      spawnPty: () => fakePty,
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
});

function createFakePty(): IFakePty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

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
    write() {
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
  } as unknown as IFakePty;
}

interface IFakePty extends IPty {
  emitData(data: string): void;
  emitExit(exitCode: number): void;
}

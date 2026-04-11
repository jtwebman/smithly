import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IPty } from "node-pty";
import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  listApprovalsForProject,
  listBlockersForProject,
  listChatMessagesForThread,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  listTaskRunsForProject,
  listWorkerSessionsForProject,
  seedInitialState,
} from "@smithly/storage";

import { PlanningSessionManager } from "./planning-session.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("PlanningSessionManager", () => {
  it("tracks Claude transcript refs, log files, and session summaries in storage", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-session-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-planning-repo-"));

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

    const fakePty = createFakePty();
    const manager = new PlanningSessionManager(context, () => undefined, {
      now: () => new Date("2026-04-10T08:00:00.000Z"),
      spawnPty: () => fakePty,
    });

    manager.ensureSession({
      projectId: fixture.project.id,
      scope: "project",
    });

    const projectThread = listChatThreadsForProject(context, fixture.project.id).find((thread) => {
      return thread.kind === "project_planning";
    });

    expect(projectThread).toBeDefined();

    const claudeSession = listWorkerSessionsForProject(context, fixture.project.id).find(
      (session) => {
        return session.workerKind === "claude" && session.transcriptRef?.startsWith("chat-thread:");
      },
    );

    expect(claudeSession).toBeDefined();
    expect(claudeSession?.status).toBe("running");
    expect(claudeSession?.transcriptRef).toContain(`chat-thread:${projectThread?.id}`);
    expect(claudeSession?.transcriptRef).toContain("|log-file:");

    const initialSummary = listMemoryNotesForProject(context, fixture.project.id).find((note) => {
      return note.id === `memory-session-summary-${claudeSession?.id}`;
    });

    expect(initialSummary?.noteType).toBe("session_summary");
    expect(initialSummary?.bodyText).toContain("status: running");

    manager.submitInput({
      bodyText: "Summarize the latest planning state.",
      projectId: fixture.project.id,
      scope: "project",
    });
    fakePty.emitData("claude ack: Summarize the latest planning state.\n");
    fakePty.emitExit(0);

    const completedSession = listWorkerSessionsForProject(context, fixture.project.id).find(
      (session) => {
        return session.id === claudeSession?.id;
      },
    );
    const completedSummary = listMemoryNotesForProject(context, fixture.project.id).find((note) => {
      return note.id === `memory-session-summary-${claudeSession?.id}`;
    });
    const logFilePath = claudeSession?.transcriptRef?.split("|log-file:")[1];

    expect(completedSession?.status).toBe("exited");
    expect(completedSummary?.bodyText).toContain("status: exited");
    expect(completedSummary?.bodyText).toContain("- human: Summarize the latest planning state.");
    expect(completedSummary?.bodyText).toContain(
      "- claude: claude ack: Summarize the latest planning state.",
    );
    expect(logFilePath).toBeDefined();
    expect(readFileSync(logFilePath ?? "", "utf8")).toContain(
      "operator> Summarize the latest planning state.",
    );
    expect(readFileSync(logFilePath ?? "", "utf8")).toContain(
      "claude ack: Summarize the latest planning state.",
    );

    manager.dispose();
    context.db.close();
  });

  it("ingests structured Claude hook events without storing them as chat messages", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-hooks-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-planning-hook-repo-"));

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

    const fakePty = createFakePty();
    const manager = new PlanningSessionManager(context, () => undefined, {
      now: () => new Date("2026-04-10T09:00:00.000Z"),
      spawnPty: () => fakePty,
    });

    manager.ensureSession({
      backlogItemId: fixture.backlogItem.id,
      projectId: fixture.project.id,
      scope: "task",
    });

    const taskThread = listChatThreadsForProject(context, fixture.project.id).find((thread) => {
      return thread.kind === "task_planning" && thread.backlogItemId === fixture.backlogItem.id;
    });

    expect(taskThread).toBeDefined();
    const chatMessageCountBefore = taskThread
      ? listChatMessagesForThread(context, taskThread.id).length
      : 0;

    fakePty.emitData(
      'smithly-hook: {"type":"approval_request","payload":{"id":"approval-hook-review","title":"Need review approval","detail":"Approve the next narrow change.","requestedBy":"claude","status":"pending"}}\n',
    );
    fakePty.emitData(
      'smithly-hook: {"type":"blocker","payload":{"id":"blocker-hook-policy","title":"Need policy answer","detail":"Clarify whether review is required.","blockerType":"policy","status":"open"}}\n',
    );
    fakePty.emitData(
      'smithly-hook: {"type":"memory_note","payload":{"id":"memory-hook-fact","title":"Review policy fact","bodyText":"High-risk work needs review.","noteType":"fact"}}\n',
    );
    fakePty.emitData(
      'smithly-hook: {"type":"task_outcome","payload":{"id":"taskrun-hook-claude","status":"awaiting_review","summaryText":"Prepared the change and waiting for review."}}\n',
    );

    expect(listApprovalsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "Approve the next narrow change.",
          id: "approval-hook-review",
          status: "pending",
          title: "Need review approval",
        }),
      ]),
    );
    expect(listBlockersForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockerType: "policy",
          detail: "Clarify whether review is required.",
          id: "blocker-hook-policy",
          status: "open",
          title: "Need policy answer",
        }),
      ]),
    );
    expect(listTaskRunsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignedWorker: "claude",
          backlogItemId: fixture.backlogItem.id,
          id: "taskrun-hook-claude",
          status: "awaiting_review",
          summaryText: "Prepared the change and waiting for review.",
        }),
      ]),
    );
    expect(listMemoryNotesForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bodyText: "High-risk work needs review.",
          id: "memory-hook-fact",
          noteType: "fact",
          title: "Review policy fact",
        }),
      ]),
    );
    expect(taskThread ? listChatMessagesForThread(context, taskThread.id).length : 0).toBe(
      chatMessageCountBefore,
    );

    manager.dispose();
    context.db.close();
  });

  it("requests a graceful pause for running project orchestration sessions", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-pause-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-planning-pause-repo-"));

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

    const fakePty = createFakePty();
    const manager = new PlanningSessionManager(context, () => undefined, {
      now: () => new Date("2026-04-10T09:30:00.000Z"),
      spawnPty: () => fakePty,
    });

    manager.ensureSession({
      projectId: fixture.project.id,
      scope: "project",
    });

    const pausePromise = manager.requestProjectPause(
      fixture.project.id,
      "Operator paused the project from the desktop controls.",
    );

    expect(fakePty.writes.at(-1)).toContain("/pause Operator paused the project");
    expect(
      listWorkerSessionsForProject(context, fixture.project.id).find(
        (session) => session.workerKind === "claude" && session.status === "waiting",
      ),
    ).toBeDefined();

    fakePty.emitExit(0);
    await pausePromise;

    expect(
      listWorkerSessionsForProject(context, fixture.project.id).find(
        (session) => session.workerKind === "claude",
      )?.status,
    ).toBe("exited");

    manager.dispose();
    context.db.close();
  });
});

function createFakePty(): IFakePty {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  const writes: string[] = [];
  let killCount = 0;

  return {
    kill() {
      killCount += 1;
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
    get killCount() {
      return killCount;
    },
    writes,
  } as unknown as IFakePty;
}
interface IFakePty extends IPty {
  emitData(data: string): void;
  emitExit(exitCode: number): void;
  readonly killCount: number;
  readonly writes: readonly string[];
}

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IPty } from "node-pty";
import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  listChatThreadsForProject,
  listMemoryNotesForProject,
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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";

import {
  deleteProjectById,
  getBacklogItemById,
  getProjectById,
  listApprovalsForProject,
  listBacklogItemsForProject,
  listBlockersForProject,
  listChatMessagesForThread,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  listProjects,
  listReviewRunsForTask,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  listWorkerSessionsForProject,
  upsertProject,
} from "./data.ts";
import { closeContext, createContext } from "./context.ts";
import { createInitialSeedFixture, seedInitialState } from "./seed.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("storage data layer", () => {
  it("persists and reads the initial state model through context-first functions", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-data-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);

    expect(listProjects(context)).toEqual([fixture.project]);
    expect(getProjectById(context, fixture.project.id)).toEqual(fixture.project);
    expect(listBacklogItemsForProject(context, fixture.project.id)).toEqual([fixture.backlogItem]);
    expect(getBacklogItemById(context, fixture.backlogItem.id)).toEqual(fixture.backlogItem);
    expect(listWorkerSessionsForProject(context, fixture.project.id)).toEqual([
      fixture.workerSession,
    ]);
    expect(listTaskRunsForProject(context, fixture.project.id)).toEqual([fixture.taskRun]);
    expect(listBlockersForProject(context, fixture.project.id)).toEqual([fixture.blocker]);
    expect(listApprovalsForProject(context, fixture.project.id)).toEqual([fixture.approval]);
    expect(listChatThreadsForProject(context, fixture.project.id)).toEqual([fixture.chatThread]);
    expect(listChatMessagesForThread(context, fixture.chatThread.id)).toEqual(fixture.chatMessages);
    expect(listMemoryNotesForProject(context, fixture.project.id)).toEqual([fixture.memoryNote]);
    expect(listVerificationRunsForTask(context, fixture.taskRun.id)).toEqual([
      fixture.verificationRun,
    ]);
    expect(listReviewRunsForTask(context, fixture.taskRun.id)).toEqual([fixture.reviewRun]);

    closeContext(context);
  });

  it("supports upsert replacement and cascading project deletion", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-data-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = createInitialSeedFixture();

    seedInitialState(context, fixture);
    upsertProject(context, {
      ...fixture.project,
      name: "Smithly Local",
      updatedAt: "2026-04-10T07:10:00.000Z",
    });

    expect(getProjectById(context, fixture.project.id)?.name).toBe("Smithly Local");
    expect(deleteProjectById(context, fixture.project.id)).toBe(true);
    expect(listProjects(context)).toEqual([]);
    expect(listBacklogItemsForProject(context, fixture.project.id)).toEqual([]);
    expect(listTaskRunsForProject(context, fixture.project.id)).toEqual([]);

    closeContext(context);
  });
});

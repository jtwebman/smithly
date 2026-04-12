import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  createDraftBacklogItemFromPlanning,
  ensureProjectPlanningThread,
  reviseBacklogItemFromPlanning,
  seedInitialState,
  registerLocalProject,
  updateProjectMetadata,
} from "@smithly/storage";

import { ProjectSchedulingManager } from "./project-scheduler.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("ProjectSchedulingManager", () => {
  it("starts the next runnable backlog item for each active project", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-scheduler-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-project-scheduler-repo-"));

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
        status: "active",
      },
      taskRun: {
        ...fixture.taskRun,
        completedAt: "2026-04-10T07:30:00.000Z",
        status: "done",
        updatedAt: "2026-04-10T07:30:00.000Z",
      },
    });
    const nextBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Next runnable work for the active project.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Next runnable task",
    });
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["This work is approved and ready."],
      backlogItemId: nextBacklogItem.id,
      priority: 95,
      readiness: "ready",
      scopeSummary: nextBacklogItem.scopeSummary ?? "",
      status: "approved",
    });

    const startSession = vi.fn();
    const ensureSession = vi.fn();
    const manager = new ProjectSchedulingManager(context, {
      ensureSession,
      startSession,
    });

    const changed = manager.processActiveProjects();

    expect(changed).toBe(true);
    expect(startSession).toHaveBeenCalledWith({
      backlogItemId: nextBacklogItem.id,
      projectId: fixture.project.id,
      summaryText: `Start Codex work for the next runnable backlog item: ${nextBacklogItem.title}.`,
    });
    expect(ensureSession).not.toHaveBeenCalled();

    context.db.close();
  });

  it("does not start new work when a project already has an active coding task", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-scheduler-"));

    temporaryDirectories.push(dataDirectory);

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
        status: "active",
      },
    });

    const startSession = vi.fn();
    const ensureSession = vi.fn();
    const manager = new ProjectSchedulingManager(context, {
      ensureSession,
      startSession,
    });

    const changed = manager.processActiveProjects();

    expect(changed).toBe(false);
    expect(startSession).not.toHaveBeenCalled();
    expect(ensureSession).toHaveBeenCalledWith(fixture.taskRun.id);

    context.db.close();
  });

  it("skips paused projects and work that is not yet runnable", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-scheduler-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-project-scheduler-repo-"));

    temporaryDirectories.push(dataDirectory, repoPath);
    mkdirSync(join(repoPath, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const project = registerLocalProject(context, {
      name: "Paused project",
      repoPath,
    });
    const planningThread = ensureProjectPlanningThread(context, project.id);
    const backlogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: project.id,
      scopeSummary: "This item is approved but still not ready.",
      sourceThreadId: planningThread.id,
      title: "Paused project pending task",
    });

    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["This item is approved but not ready."],
      backlogItemId: backlogItem.id,
      readiness: "not_ready",
      scopeSummary: backlogItem.scopeSummary ?? "",
      status: "approved",
    });
    updateProjectMetadata(context, {
      projectId: project.id,
      status: "paused",
    });

    const startSession = vi.fn();
    const ensureSession = vi.fn();
    const manager = new ProjectSchedulingManager(context, {
      ensureSession,
      startSession,
    });

    const changed = manager.processActiveProjects();

    expect(changed).toBe(false);
    expect(startSession).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();

    context.db.close();
  });
});

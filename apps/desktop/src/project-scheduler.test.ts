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
  upsertBlocker,
  reviseBacklogItemFromPlanning,
  seedInitialState,
  registerLocalProject,
  updateProjectMetadata,
  upsertApproval,
  upsertChatMessage,
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
      approval: {
        ...fixture.approval,
        decidedAt: "2026-04-10T07:10:00.000Z",
        decisionBy: "human",
        status: "approved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
      blocker: {
        ...fixture.blocker,
        resolutionNote: "No blocker remains for this scheduler test.",
        resolvedAt: "2026-04-10T07:10:00.000Z",
        status: "resolved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
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
      approval: {
        ...fixture.approval,
        decidedAt: "2026-04-10T07:10:00.000Z",
        decisionBy: "human",
        status: "approved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
      blocker: {
        ...fixture.blocker,
        resolutionNote: "No blocker remains for this scheduler test.",
        resolvedAt: "2026-04-10T07:10:00.000Z",
        status: "resolved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
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

  it("runs the idle backlog loop for active projects that are waiting for human input", () => {
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
      taskRun: {
        ...fixture.taskRun,
        completedAt: "2026-04-10T07:30:00.000Z",
        status: "done",
        updatedAt: "2026-04-10T07:30:00.000Z",
      },
      approval: {
        ...fixture.approval,
        decidedAt: "2026-04-10T07:10:00.000Z",
        decisionBy: "human",
        status: "approved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
      blocker: {
        ...fixture.blocker,
        resolutionNote: "No blocker remains for this scheduler test.",
        resolvedAt: "2026-04-10T07:10:00.000Z",
        status: "resolved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
    });
    upsertApproval(context, {
      backlogItemId: fixture.backlogItem.id,
      createdAt: "2026-04-10T07:35:00.000Z",
      detail: "Operator approval is still pending.",
      id: "approval-scheduler-waiting-human",
      projectId: fixture.project.id,
      requestedBy: "claude",
      status: "pending",
      title: "Need operator approval",
      updatedAt: "2026-04-10T07:35:00.000Z",
    });

    const startSession = vi.fn();
    const ensureSession = vi.fn();
    const submitInput = vi.fn();
    const manager = new ProjectSchedulingManager(context, {
      ensureSession,
      startSession,
    }, {
      submitInput,
    });

    expect(manager.processActiveProjects()).toBe(true);
    expect(startSession).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();
    expect(submitInput).toHaveBeenCalledTimes(1);
    expect(submitInput.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        projectId: fixture.project.id,
        scope: "project",
      }),
    );
    expect(submitInput.mock.calls[0]?.[0]?.bodyText).toContain(
      "Run the default idle backlog-generation loop for this project.",
    );
    expect(submitInput.mock.calls[0]?.[0]?.bodyText).toContain("Need operator approval");

    context.db.close();
  });

  it("skips active projects that are waiting for credits", () => {
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
      taskRun: {
        ...fixture.taskRun,
        completedAt: "2026-04-10T07:30:00.000Z",
        status: "done",
        updatedAt: "2026-04-10T07:30:00.000Z",
      },
      approval: {
        ...fixture.approval,
        decidedAt: "2026-04-10T07:10:00.000Z",
        decisionBy: "human",
        status: "approved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
      blocker: {
        ...fixture.blocker,
        resolutionNote: "No blocker remains for this scheduler test.",
        resolvedAt: "2026-04-10T07:10:00.000Z",
        status: "resolved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
    });
    updateProjectMetadata(context, {
      executionState: "waiting_for_credit",
      projectId: fixture.project.id,
    });

    const startSession = vi.fn();
    const ensureSession = vi.fn();
    const submitInput = vi.fn();
    const manager = new ProjectSchedulingManager(context, {
      ensureSession,
      startSession,
    }, {
      submitInput,
    });

    expect(manager.processActiveProjects()).toBe(true);
    expect(startSession).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();
    expect(submitInput).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: fixture.project.id,
        scope: "project",
      }),
    );
    expect(submitInput.mock.calls[0]?.[0]?.bodyText).toContain(
      "waiting on provider credits or quota",
    );

    context.db.close();
  });

  it("runs the idle backlog loop for active projects blocked on external dependencies", () => {
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
      approval: {
        ...fixture.approval,
        decidedAt: "2026-04-10T07:10:00.000Z",
        decisionBy: "human",
        status: "approved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
      blocker: {
        ...fixture.blocker,
        resolutionNote: "No blocker remains for this scheduler test.",
        resolvedAt: "2026-04-10T07:10:00.000Z",
        status: "resolved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
      project: {
        ...fixture.project,
        status: "active",
      },
      taskRun: {
        ...fixture.taskRun,
        completedAt: "2026-04-10T07:30:00.000Z",
        status: "done",
        updatedAt: "2026-04-10T07:30:00.000Z",
      },
    });
    upsertBlocker(context, {
      blockerType: "system",
      createdAt: "2026-04-10T07:35:00.000Z",
      detail: "Third-party dependency is still unavailable.",
      id: "blocker-scheduler-external-dependency",
      projectId: fixture.project.id,
      status: "open",
      title: "Wait for external dependency",
      updatedAt: "2026-04-10T07:35:00.000Z",
    });

    const startSession = vi.fn();
    const ensureSession = vi.fn();
    const submitInput = vi.fn();
    const manager = new ProjectSchedulingManager(context, {
      ensureSession,
      startSession,
    }, {
      submitInput,
    });

    expect(manager.processActiveProjects()).toBe(true);
    expect(startSession).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();
    expect(submitInput).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: fixture.project.id,
        scope: "project",
      }),
    );
    expect(submitInput.mock.calls[0]?.[0]?.bodyText).toContain(
      "blocked on external dependencies or system issues",
    );
    expect(submitInput.mock.calls[0]?.[0]?.bodyText).toContain(
      "Wait for external dependency",
    );

    context.db.close();
  });

  it("does not repeat the same idle backlog loop prompt once it has been recorded", () => {
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
      taskRun: {
        ...fixture.taskRun,
        completedAt: "2026-04-10T07:30:00.000Z",
        status: "done",
        updatedAt: "2026-04-10T07:30:00.000Z",
      },
      approval: {
        ...fixture.approval,
        decidedAt: "2026-04-10T07:10:00.000Z",
        decisionBy: "human",
        status: "approved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
      blocker: {
        ...fixture.blocker,
        resolutionNote: "No blocker remains for this scheduler test.",
        resolvedAt: "2026-04-10T07:10:00.000Z",
        status: "resolved",
        updatedAt: "2026-04-10T07:10:00.000Z",
      },
    });
    updateProjectMetadata(context, {
      executionState: "waiting_for_credit",
      projectId: fixture.project.id,
    });

    const startSession = vi.fn();
    const ensureSession = vi.fn();
    const submitInput = vi.fn((input: { readonly bodyText: string; readonly projectId: string }) => {
      const planningThread = ensureProjectPlanningThread(context, input.projectId);

      upsertChatMessage(context, {
        bodyText: input.bodyText,
        createdAt: "2026-04-10T07:40:00.000Z",
        id: "message-idle-loop-credit-wait",
        metadataJson: "{}",
        role: "human",
        threadId: planningThread.id,
      });
    });
    const manager = new ProjectSchedulingManager(
      context,
      {
        ensureSession,
        startSession,
      },
      {
        submitInput,
      },
    );

    expect(manager.processActiveProjects()).toBe(true);
    expect(manager.processActiveProjects()).toBe(false);
    expect(submitInput).toHaveBeenCalledTimes(1);

    context.db.close();
  });
});

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  getProjectById,
  parseProjectMetadata,
  seedInitialState,
  registerLocalProject,
  updateProjectMetadata,
  upsertApproval,
  upsertBlocker,
} from "@smithly/storage";

import {
  detectCreditPauseReason,
  ProjectExecutionManager,
  resolveProjectExecutionState,
} from "./project-execution.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("ProjectExecutionManager", () => {
  it("plays paused projects and resumes active orchestration sessions on demand", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-exec-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-project-exec-repo-"));

    temporaryDirectories.push(dataDirectory, repoPath);
    mkdirSync(join(repoPath, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const project = registerLocalProject(context, {
      name: "Execution Fixture",
      repoPath,
    });
    const ensureSession = vi.fn();
    const requestProjectPause = vi.fn(async () => undefined);
    const manager = new ProjectExecutionManager(context, {
      ensureSession,
      requestProjectPause,
    });

    expect(project.status).toBe("paused");

    const playedProject = manager.playProject(project.id);

    expect(playedProject.status).toBe("active");
    expect(parseProjectMetadata(playedProject).executionState).toBe("active");
    expect(ensureSession).toHaveBeenCalledWith({
      projectId: project.id,
      scope: "project",
    });

    context.db.close();
  });

  it("pauses active projects and asks orchestration to drain safely", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-exec-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-project-exec-repo-"));

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
    });

    const ensureSession = vi.fn();
    const requestProjectPause = vi.fn(async () => undefined);
    const manager = new ProjectExecutionManager(context, {
      ensureSession,
      requestProjectPause,
    });

    const pausedProject = await manager.pauseProject(
      fixture.project.id,
      "Operator paused the project from the desktop controls.",
    );

    expect(pausedProject.status).toBe("paused");
    expect(parseProjectMetadata(pausedProject).executionState).toBe("paused");
    expect(requestProjectPause).toHaveBeenCalledWith(
      fixture.project.id,
      "Operator paused the project from the desktop controls.",
    );
    expect(ensureSession).not.toHaveBeenCalled();

    context.db.close();
  });

  it("restarts hidden orchestration for projects that were already running", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-exec-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-project-exec-repo-"));

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
    });

    const ensureSession = vi.fn();
    const manager = new ProjectExecutionManager(context, {
      ensureSession,
      requestProjectPause: async () => undefined,
    });

    manager.resumeActiveProjects();

    expect(ensureSession).toHaveBeenCalledWith({
      projectId: fixture.project.id,
      scope: "project",
    });

    context.db.close();
  });

  it("resolves waiting-for-human and blocked execution states from current project blockers", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-exec-"));

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
        resolutionNote: "No blocker remains for this execution-state test.",
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
    upsertApproval(context, {
      backlogItemId: fixture.backlogItem.id,
      createdAt: "2026-04-10T07:35:00.000Z",
      detail: "Operator approval is still pending.",
      id: "approval-project-waiting-human",
      projectId: fixture.project.id,
      requestedBy: "claude",
      status: "pending",
      title: "Need operator approval",
      updatedAt: "2026-04-10T07:35:00.000Z",
    });

    expect(resolveProjectExecutionState(context, fixture.project.id)).toBe("waiting_for_human");

    upsertApproval(context, {
      backlogItemId: fixture.backlogItem.id,
      createdAt: "2026-04-10T07:35:00.000Z",
      decidedAt: "2026-04-10T07:36:00.000Z",
      decisionBy: "human",
      detail: "Operator approval cleared.",
      id: "approval-project-waiting-human",
      projectId: fixture.project.id,
      requestedBy: "claude",
      status: "approved",
      title: "Need operator approval",
      updatedAt: "2026-04-10T07:36:00.000Z",
    });
    upsertBlocker(context, {
      backlogItemId: fixture.backlogItem.id,
      blockerType: "system",
      createdAt: "2026-04-10T07:40:00.000Z",
      detail: "External system dependency is still unresolved.",
      id: "blocker-project-system",
      projectId: fixture.project.id,
      status: "open",
      title: "Waiting on external dependency",
      updatedAt: "2026-04-10T07:40:00.000Z",
    });

    expect(resolveProjectExecutionState(context, fixture.project.id)).toBe("blocked");

    context.db.close();
  });

  it("preserves explicit waiting-for-credit state until the operator changes it", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-exec-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-project-exec-repo-"));

    temporaryDirectories.push(dataDirectory, repoPath);
    mkdirSync(join(repoPath, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const project = registerLocalProject(context, {
      repoPath,
    });
    const ensureSession = vi.fn();
    const requestProjectPause = vi.fn(async () => undefined);
    const manager = new ProjectExecutionManager(context, {
      ensureSession,
      requestProjectPause,
    });

    manager.playProject(project.id);
    const waitingForCreditProject = updateProjectMetadata(context, {
      executionState: "waiting_for_credit",
      projectId: project.id,
      status: "active",
    });

    expect(resolveProjectExecutionState(context, project.id)).toBe("waiting_for_credit");
    expect(parseProjectMetadata(waitingForCreditProject).executionState).toBe("waiting_for_credit");

    context.db.close();
  });

  it("clears waiting-for-credit state when the operator presses play again", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-exec-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-project-exec-repo-"));

    temporaryDirectories.push(dataDirectory, repoPath);
    mkdirSync(join(repoPath, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const project = registerLocalProject(context, {
      repoPath,
    });
    const ensureSession = vi.fn();
    const manager = new ProjectExecutionManager(context, {
      ensureSession,
      requestProjectPause: vi.fn(async () => undefined),
    });

    manager.playProject(project.id);
    updateProjectMetadata(context, {
      executionState: "waiting_for_credit",
      projectId: project.id,
      status: "active",
    });

    const resumedProject = manager.playProject(project.id);

    expect(parseProjectMetadata(resumedProject).executionState).toBe("active");
    expect(ensureSession).toHaveBeenLastCalledWith({
      projectId: project.id,
      scope: "project",
    });

    context.db.close();
  });

  it("pauses active projects when a worker reports a credit or quota issue", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-exec-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-project-exec-repo-"));

    temporaryDirectories.push(dataDirectory, repoPath);
    mkdirSync(join(repoPath, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const project = registerLocalProject(context, {
      repoPath,
    });
    const requestProjectPause = vi.fn(async () => undefined);
    const manager = new ProjectExecutionManager(context, {
      ensureSession: vi.fn(),
      requestProjectPause,
    });

    manager.playProject(project.id);
    const pausedProject = await manager.pauseProjectForCredit(
      project.id,
      "Smithly paused project execution because a worker reported a credits or quota issue: rate limit exceeded",
    );

    expect(pausedProject.status).toBe("active");
    expect(parseProjectMetadata(pausedProject).executionState).toBe("waiting_for_credit");
    expect(requestProjectPause).toHaveBeenCalledWith(
      project.id,
      "Smithly paused project execution because a worker reported a credits or quota issue: rate limit exceeded",
    );

    context.db.close();
  });

  it("detects credit and quota exhaustion from worker output", () => {
    expect(
      detectCreditPauseReason("Error: rate limit exceeded for the current billing period"),
    ).toContain("rate limit exceeded for the current billing period");
    expect(detectCreditPauseReason("normal progress output")).toBeNull();
  });

  it("reconciles stored execution state when blockers or approvals change", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-exec-"));

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
        resolutionNote: "No blocker remains for this execution-state test.",
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
      backlogItemId: fixture.backlogItem.id,
      blockerType: "human",
      createdAt: "2026-04-10T07:35:00.000Z",
      detail: "Waiting for the operator to answer.",
      id: "blocker-project-human",
      projectId: fixture.project.id,
      status: "open",
      title: "Need operator input",
      updatedAt: "2026-04-10T07:35:00.000Z",
    });

    const manager = new ProjectExecutionManager(context, {
      ensureSession: vi.fn(),
      requestProjectPause: vi.fn(async () => undefined),
    });

    expect(manager.reconcileExecutionStates()).toBe(true);
    expect(parseProjectMetadata(getProjectById(context, fixture.project.id)!).executionState).toBe(
      "waiting_for_human",
    );
    expect(manager.reconcileExecutionStates()).toBe(false);

    context.db.close();
  });
});

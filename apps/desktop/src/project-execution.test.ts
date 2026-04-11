import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  seedInitialState,
  registerLocalProject,
} from "@smithly/storage";

import { ProjectExecutionManager } from "./project-execution.ts";

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
});

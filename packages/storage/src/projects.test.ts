import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig, DEFAULT_PROJECT_PLANNING_LOOPS } from "@smithly/core";

import { closeContext, createContext } from "./context.ts";
import { listProjects } from "./data.ts";
import {
  parseProjectMetadata,
  ProjectRegistrationError,
  registerLocalProject,
  updateProjectMetadata,
} from "./projects.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("project registration", () => {
  it("registers a local git working tree using a canonical repo path", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-data-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-project-repo-"));

    temporaryDirectories.push(dataDirectory, repoDirectory);
    mkdirSync(join(repoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    const project = registerLocalProject(context, {
      approvalPolicy: {
        requireApprovalForHighRiskTasks: false,
      },
      metadata: {
        owner: "jt",
      },
      name: "Fixture Repo",
      repoPath: `${repoDirectory}/.`,
      verificationCommands: ["npm run check", "npm run test"],
    });

    expect(project.name).toBe("Fixture Repo");
    expect(project.repoPath).toBe(repoDirectory);
    expect(project.status).toBe("paused");
    expect(listProjects(context)).toEqual([project]);
    expect(parseProjectMetadata(project)).toEqual({
      approvalPolicy: {
        requireApprovalForHighRiskTasks: false,
        requireApprovalForNewBacklogItems: true,
        requireApprovalForScopeChanges: true,
      },
      executionState: "paused",
      metadata: {
        owner: "jt",
      },
      planningLoops: DEFAULT_PROJECT_PLANNING_LOOPS,
      verificationCommands: ["npm run check", "npm run test"],
    });

    closeContext(context);
  });

  it("rejects duplicate registrations for the same local repo path", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-data-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-project-repo-"));

    temporaryDirectories.push(dataDirectory, repoDirectory);
    mkdirSync(join(repoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    registerLocalProject(context, {
      repoPath: repoDirectory,
    });

    expect(() =>
      registerLocalProject(context, {
        repoPath: `${repoDirectory}/.`,
      }),
    ).toThrowError(ProjectRegistrationError);

    closeContext(context);
  });

  it("rejects directories that are not git working trees", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-data-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-project-repo-"));

    temporaryDirectories.push(dataDirectory, repoDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    expect(() =>
      registerLocalProject(context, {
        repoPath: repoDirectory,
      }),
    ).toThrowError("Local repo path must point to a git working tree");

    closeContext(context);
  });

  it("updates project metadata with typed verification and approval settings", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-data-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-project-repo-"));

    temporaryDirectories.push(dataDirectory, repoDirectory);
    mkdirSync(join(repoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const project = registerLocalProject(context, {
      repoPath: repoDirectory,
    });

    const updatedProject = updateProjectMetadata(context, {
      approvalPolicy: {
        requireApprovalForHighRiskTasks: false,
        requireApprovalForNewBacklogItems: false,
        requireApprovalForScopeChanges: true,
      },
      defaultBranch: "main",
      executionState: "waiting_for_credit",
      metadata: {
        owner: "jt",
        runtime: "desktop",
      },
      projectId: project.id,
      verificationCommands: ["npm run lint"],
    });

    expect(parseProjectMetadata(updatedProject)).toEqual({
      approvalPolicy: {
        requireApprovalForHighRiskTasks: false,
        requireApprovalForNewBacklogItems: false,
        requireApprovalForScopeChanges: true,
      },
      executionState: "waiting_for_credit",
      metadata: {
        owner: "jt",
        runtime: "desktop",
      },
      planningLoops: DEFAULT_PROJECT_PLANNING_LOOPS,
      verificationCommands: ["npm run lint"],
    });
    expect(updatedProject.defaultBranch).toBe("main");

    closeContext(context);
  });

  it("persists reordered and custom planning loops in project metadata", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-data-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-project-repo-"));

    temporaryDirectories.push(dataDirectory, repoDirectory);
    mkdirSync(join(repoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const project = registerLocalProject(context, {
      repoPath: repoDirectory,
    });
    const idleLoop = DEFAULT_PROJECT_PLANNING_LOOPS[0]!;

    const updatedProject = updateProjectMetadata(context, {
      planningLoops: [
        {
          enabled: true,
          id: "loop-custom-market-scan",
          kind: "custom",
          prompt: "Run a market scan loop and draft human-reviewed backlog items.",
          title: "Market scan",
          trigger: "idle",
        },
        {
          ...idleLoop,
          enabled: false,
        },
      ],
      projectId: project.id,
    });

    expect(parseProjectMetadata(updatedProject).planningLoops).toEqual([
      {
        enabled: true,
        id: "loop-custom-market-scan",
        kind: "custom",
        prompt: "Run a market scan loop and draft human-reviewed backlog items.",
        title: "Market scan",
        trigger: "idle",
      },
      {
        ...idleLoop,
        enabled: false,
      },
    ]);

    closeContext(context);
  });

  it("updates project repo path and archived status", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-project-data-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-project-repo-"));
    const movedRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-project-repo-moved-"));

    temporaryDirectories.push(dataDirectory, repoDirectory, movedRepoDirectory);
    mkdirSync(join(repoDirectory, ".git"));
    mkdirSync(join(movedRepoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const project = registerLocalProject(context, {
      repoPath: repoDirectory,
    });

    const updatedProject = updateProjectMetadata(context, {
      projectId: project.id,
      repoPath: movedRepoDirectory,
      status: "archived",
    });

    expect(updatedProject.repoPath).toBe(movedRepoDirectory);
    expect(updatedProject.status).toBe("archived");

    closeContext(context);
  });

  it("parses legacy project metadata JSON without dropping old fields", () => {
    expect(
      parseProjectMetadata({
        metadataJson: '{"themePreference":"system","verificationCommand":"npm run check"}',
      }),
    ).toEqual({
      approvalPolicy: {
        requireApprovalForHighRiskTasks: true,
        requireApprovalForNewBacklogItems: true,
        requireApprovalForScopeChanges: true,
      },
      executionState: "paused",
      metadata: {
        themePreference: "system",
      },
      planningLoops: DEFAULT_PROJECT_PLANNING_LOOPS,
      verificationCommands: ["npm run check"],
    });
  });

  it("falls back to active execution state for legacy active projects without explicit metadata", () => {
    expect(
      parseProjectMetadata({
        metadataJson: '{"verificationCommand":"npm run check"}',
        status: "active",
      }),
    ).toEqual({
      approvalPolicy: {
        requireApprovalForHighRiskTasks: true,
        requireApprovalForNewBacklogItems: true,
        requireApprovalForScopeChanges: true,
      },
      executionState: "active",
      metadata: {},
      planningLoops: DEFAULT_PROJECT_PLANNING_LOOPS,
      verificationCommands: ["npm run check"],
    });
  });
});

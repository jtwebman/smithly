import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";

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
    expect(project.status).toBe("active");
    expect(listProjects(context)).toEqual([project]);
    expect(parseProjectMetadata(project)).toEqual({
      approvalPolicy: {
        requireApprovalForHighRiskTasks: false,
        requireApprovalForNewBacklogItems: true,
        requireApprovalForScopeChanges: true,
      },
      metadata: {
        owner: "jt",
      },
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
      metadata: {
        owner: "jt",
        runtime: "desktop",
      },
      verificationCommands: ["npm run lint"],
    });

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
      metadata: {
        themePreference: "system",
      },
      verificationCommands: ["npm run check"],
    });
  });
});

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";

import { closeContext, createContext } from "./context.ts";
import { listProjects } from "./data.ts";
import { ProjectRegistrationError, registerLocalProject } from "./projects.ts";

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
      name: "Fixture Repo",
      repoPath: `${repoDirectory}/.`,
    });

    expect(project.name).toBe("Fixture Repo");
    expect(project.repoPath).toBe(repoDirectory);
    expect(project.status).toBe("active");
    expect(listProjects(context)).toEqual([project]);

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
});

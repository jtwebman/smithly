import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  listMemoryNotesForProject,
  seedInitialState,
  updateProjectMetadata,
} from "@smithly/storage";

import { TaskGitManager, formatTaskBranchName } from "./task-git-manager.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("TaskGitManager", () => {
  it("creates smithly task branches from the detected default branch", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-task-git-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-task-repo-"));

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
        createdAt: fixture.project.createdAt,
        id: fixture.project.id,
        metadataJson: fixture.project.metadataJson,
        name: fixture.project.name,
        repoPath,
        status: fixture.project.status,
        updatedAt: fixture.project.updatedAt,
      },
    });

    const commands: string[] = [];
    const manager = new TaskGitManager(context, {
      now: () => new Date("2026-04-11T08:00:00.000Z"),
      runCommand(command, args) {
        commands.push(`${command} ${args.join(" ")}`);

        if (args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: "origin/main\n",
          };
        }

        return {
          exitCode: 0,
          stderr: "",
          stdout: "",
        };
      },
    });

    const state = manager.prepareTaskBranch(fixture.taskRun.id);

    expect(state.branchName).toBe(
      formatTaskBranchName(fixture.taskRun.id, fixture.backlogItem.title),
    );
    expect(state.defaultBranch).toBe("main");
    expect(commands).toEqual([
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD",
      "git checkout main",
      `git checkout -B ${state.branchName} main`,
    ]);
    expect(listMemoryNotesForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `memory-task-git-${fixture.taskRun.id}`,
          title: "Task git lifecycle",
        }),
      ]),
    );

    context.db.close();
  });

  it("commits WIP with --no-verify and checks out the default branch on pause", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-task-git-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-task-repo-"));

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
        defaultBranch: "main",
        repoPath,
      },
    });

    const commands: string[] = [];
    const manager = new TaskGitManager(context, {
      now: () => new Date("2026-04-11T08:15:00.000Z"),
      runCommand(command, args) {
        commands.push(`${command} ${args.join(" ")}`);

        return {
          exitCode: 0,
          stderr: "",
          stdout: args.join(" ") === "status --porcelain" ? " M apps/desktop/src/main.ts\n" : "",
        };
      },
    });

    manager.prepareTaskBranch(fixture.taskRun.id);
    const state = manager.pauseTaskBranch(fixture.taskRun.id);

    expect(state.status).toBe("paused");
    expect(state.pauseCommitCreated).toBe(true);
    expect(commands).toContain("git add -A");
    expect(commands).toContain(`git commit --no-verify -m WIP: pause ${fixture.taskRun.id}`);
    expect(commands.at(-1)).toBe("git checkout main");

    context.db.close();
  });

  it("pushes task branches and opens pull requests on completion", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-task-git-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-task-repo-"));

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
        defaultBranch: "main",
        repoPath,
      },
    });
    updateProjectMetadata(context, {
      defaultBranch: "main",
      projectId: fixture.project.id,
    });

    const commands: string[] = [];
    const manager = new TaskGitManager(context, {
      now: () => new Date("2026-04-11T08:30:00.000Z"),
      runCommand(command, args) {
        commands.push(`${command} ${args.join(" ")}`);

        if (command === "gh" && args[0] === "pr" && args[1] === "create") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: "https://github.com/jtwebman/smithly/pull/77\n",
          };
        }

        return {
          exitCode: 0,
          stderr: "",
          stdout: "",
        };
      },
    });

    manager.prepareTaskBranch(fixture.taskRun.id);
    const state = manager.openPullRequest(fixture.taskRun.id);

    expect(state.status).toBe("pr_opened");
    expect(state.pullRequestUrl).toBe("https://github.com/jtwebman/smithly/pull/77");
    expect(commands).toContain(`git push -u origin ${state.branchName}`);
    expect(commands).toContain(
      `gh pr create --base main --head ${state.branchName} --title ${fixture.backlogItem.title} --body ${fixture.taskRun.summaryText}`,
    );

    context.db.close();
  });
});

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  listBlockersForProject,
  listMemoryNotesForProject,
  seedInitialState,
  upsertBlocker,
  updateProjectMetadata,
} from "@smithly/storage";

import {
  BlockerRoutingManager,
  answerHelperBlocker,
  classifyBlocker,
} from "./blocker-routing-manager.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("BlockerRoutingManager", () => {
  it("classifies policy, helper-model, and human blockers", () => {
    expect(classifyBlocker("Need policy answer", "Is operator approval required?")).toBe("policy");
    expect(classifyBlocker("Need command", "What command runs verification?")).toBe("helper_model");
    expect(classifyBlocker("Need design direction", "Choose the product tradeoff.")).toBe("human");
    expect(
      classifyBlocker("External dependency wait", "Third-party service is still down.", "system"),
    ).toBe("system");
  });

  it("auto-resolves helper-model blockers with a concrete answer", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-blocker-routing-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-blocker-routing-repo-"));

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
    updateProjectMetadata(context, {
      defaultBranch: "main",
      projectId: fixture.project.id,
      verificationCommands: ["npm run check", "npm run test"],
    });
    upsertBlocker(context, {
      backlogItemId: fixture.backlogItem.id,
      blockerType: "human",
      createdAt: "2026-04-11T09:00:00.000Z",
      detail: "What command runs verification for this project?",
      id: "blocker-helper-route",
      projectId: fixture.project.id,
      status: "open",
      taskRunId: fixture.taskRun.id,
      title: "Need verification command",
      updatedAt: "2026-04-11T09:00:00.000Z",
    });

    const manager = new BlockerRoutingManager(context, {
      now: () => new Date("2026-04-11T09:05:00.000Z"),
    });
    manager.processOpenBlockers();

    expect(listBlockersForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockerType: "helper_model",
          id: "blocker-helper-route",
          resolutionNote:
            "Use the configured verification commands for this project: npm run check | npm run test.",
          status: "resolved",
        }),
      ]),
    );
    expect(listMemoryNotesForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Helper blocker answer",
        }),
      ]),
    );

    context.db.close();
  });

  it("answers branch questions from recorded project metadata", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-blocker-answer-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-blocker-answer-repo-"));

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

    expect(answerHelperBlocker(context, fixture.project.id, "What is the default branch?")).toBe(
      "The current default branch is main.",
    );

    context.db.close();
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  listVerificationRunsForTask,
  seedInitialState,
  upsertVerificationRun,
} from "@smithly/storage";

import { VerificationManager } from "./verification-manager.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("VerificationManager", () => {
  it("runs queued verification commands and records artifacts", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-verification-"));
    const repoPath = mkdtempSync(join(tmpdir(), "smithly-verification-repo-"));

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
    upsertVerificationRun(context, {
      commandText: "npm run check",
      createdAt: "2026-04-10T12:00:00.000Z",
      id: "verification-runner-test",
      projectId: fixture.project.id,
      status: "queued",
      taskRunId: fixture.taskRun.id,
      updatedAt: "2026-04-10T12:00:00.000Z",
    });

    const manager = new VerificationManager(context, {
      now: () => new Date("2026-04-10T12:05:00.000Z"),
      spawnProcess: (() => {
        const child = Object.assign(new EventEmitter(), {
          stderr: new PassThrough(),
          stdout: new PassThrough(),
        }) as EventEmitter & {
          readonly stderr: PassThrough;
          readonly stdout: PassThrough;
        };
        queueMicrotask(() => {
          child.stdout.write("verification ok\n");
          child.stderr.write("warnings: none\n");
          child.emit("close", 0);
        });
        return child as never;
      }) as typeof import("node:child_process").spawn,
    });

    manager.processQueuedRuns();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const verificationRun = listVerificationRunsForTask(context, fixture.taskRun.id).find(
      (candidate) => {
        return candidate.id === "verification-runner-test";
      },
    );

    expect(verificationRun?.status).toBe("passed");
    expect(verificationRun?.summaryText).toBe("Verification passed.");
    expect(verificationRun?.artifactPath).toBeDefined();
    expect(readFileSync(verificationRun?.artifactPath ?? "", "utf8")).toContain("verification ok");

    context.db.close();
  });
});

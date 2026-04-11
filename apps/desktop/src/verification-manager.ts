import { appendFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import {
  getProjectById,
  listProjects,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  upsertVerificationRun,
  type IStorageContext,
} from "@smithly/storage";

export interface IVerificationManagerOptions {
  readonly now?: () => Date;
  readonly spawnProcess?: typeof spawn;
}

export class VerificationManager {
  private readonly activeVerificationRunIds = new Set<string>();
  private readonly now: () => Date;
  private readonly spawnProcess: typeof spawn;

  public constructor(
    private readonly context: IStorageContext,
    options: IVerificationManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  public processQueuedRuns(): void {
    for (const project of listProjects(this.context)) {
      for (const taskRun of listTaskRunsForProject(this.context, project.id)) {
        for (const verificationRun of listVerificationRunsForTask(this.context, taskRun.id)) {
          if (
            verificationRun.status !== "queued" ||
            this.activeVerificationRunIds.has(verificationRun.id)
          ) {
            continue;
          }

          this.runVerification(verificationRun.id, project.id, verificationRun.taskRunId);
        }
      }
    }
  }

  private runVerification(verificationRunId: string, projectId: string, taskRunId: string): void {
    const verificationRun = listVerificationRunsForTask(this.context, taskRunId).find(
      (candidate) => {
        return candidate.id === verificationRunId;
      },
    );
    const project = getProjectById(this.context, projectId);

    if (verificationRun === undefined || project === null) {
      return;
    }

    const timestamp = this.now().toISOString();
    const artifactPath = join(
      this.context.config.storage.dataDirectory,
      "verification-artifacts",
      `${verificationRun.id}.log`,
    );

    mkdirSync(dirname(artifactPath), { recursive: true });
    upsertVerificationRun(this.context, {
      ...verificationRun,
      artifactPath,
      startedAt: timestamp,
      status: "running",
      updatedAt: timestamp,
    });
    this.activeVerificationRunIds.add(verificationRun.id);

    const shell = process.env.SHELL?.trim() || "/bin/sh";
    const childProcess = this.spawnProcess(shell, ["-lc", verificationRun.commandText], {
      cwd: project.repoPath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    childProcess.stdout?.on("data", (chunk) => {
      appendFileSync(artifactPath, String(chunk));
    });
    childProcess.stderr?.on("data", (chunk) => {
      appendFileSync(artifactPath, String(chunk));
    });
    childProcess.on("close", (exitCode) => {
      const completedAt = this.now().toISOString();

      this.activeVerificationRunIds.delete(verificationRun.id);
      upsertVerificationRun(this.context, {
        ...verificationRun,
        artifactPath,
        completedAt,
        startedAt: timestamp,
        status: exitCode === 0 ? "passed" : "failed",
        summaryText:
          exitCode === 0
            ? "Verification passed."
            : `Verification failed (${exitCode ?? "unknown"}).`,
        updatedAt: completedAt,
      });
    });
  }
}

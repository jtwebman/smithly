import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type { IContext, IProjectRecord } from "@smithly/core";

import { listProjects, upsertProject } from "./data.ts";

export interface IRegisterLocalProjectInput {
  readonly repoPath: string;
  readonly name?: string;
}

export class ProjectRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRegistrationError";
  }
}

export function registerLocalProject(
  context: IContext,
  input: IRegisterLocalProjectInput,
): IProjectRecord {
  const repoPath = normalizeLocalRepoPath(input.repoPath);

  if (!looksLikeGitWorkingTree(repoPath)) {
    throw new ProjectRegistrationError(
      `Local repo path must point to a git working tree: ${repoPath}`,
    );
  }

  const existingProject = listProjects(context).find((project) => project.repoPath === repoPath);

  if (existingProject !== undefined) {
    throw new ProjectRegistrationError(`Project is already registered for path: ${repoPath}`);
  }

  const timestamp = new Date().toISOString();
  const normalizedName = input.name?.trim();
  const project: IProjectRecord = {
    createdAt: timestamp,
    id: `project-${randomUUID()}`,
    metadataJson: "{}",
    name: normalizedName && normalizedName.length > 0 ? normalizedName : basename(repoPath),
    repoPath,
    status: "active",
    updatedAt: timestamp,
  };

  upsertProject(context, project);

  return project;
}

function normalizeLocalRepoPath(repoPath: string): string {
  const trimmedRepoPath = repoPath.trim();

  if (trimmedRepoPath.length === 0) {
    throw new ProjectRegistrationError("Local repo path is required.");
  }

  const resolvedRepoPath = resolve(trimmedRepoPath);

  if (!existsSync(resolvedRepoPath)) {
    throw new ProjectRegistrationError(`Local repo path does not exist: ${resolvedRepoPath}`);
  }

  if (!lstatSync(resolvedRepoPath).isDirectory()) {
    throw new ProjectRegistrationError(`Local repo path must be a directory: ${resolvedRepoPath}`);
  }

  return realpathSync(resolvedRepoPath);
}

function looksLikeGitWorkingTree(repoPath: string): boolean {
  return existsSync(join(repoPath, ".git"));
}

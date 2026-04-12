import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type {
  IContext,
  IProjectApprovalPolicy,
  IProjectMetadata,
  IProjectRecord,
  ProjectExecutionState,
} from "@smithly/core";

import { getProjectById, listProjects, upsertProject } from "./data.ts";

export interface IRegisterLocalProjectInput {
  readonly approvalPolicy?: Partial<IProjectApprovalPolicy>;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly repoPath: string;
  readonly verificationCommands?: readonly string[];
}

export interface IUpdateProjectMetadataInput {
  readonly approvalPolicy?: Partial<IProjectApprovalPolicy>;
  readonly defaultBranch?: string;
  readonly executionState?: ProjectExecutionState;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly projectId: string;
  readonly repoPath?: string;
  readonly status?: IProjectRecord["status"];
  readonly verificationCommands?: readonly string[];
}

export class ProjectRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRegistrationError";
  }
}

export const DEFAULT_PROJECT_APPROVAL_POLICY: IProjectApprovalPolicy = {
  requireApprovalForHighRiskTasks: true,
  requireApprovalForNewBacklogItems: true,
  requireApprovalForScopeChanges: true,
};
export const DEFAULT_PROJECT_EXECUTION_STATE: ProjectExecutionState = "paused";

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
    metadataJson: serializeProjectMetadata({
      approvalPolicy: normalizeApprovalPolicy(input.approvalPolicy),
      executionState: DEFAULT_PROJECT_EXECUTION_STATE,
      metadata: normalizeMetadataEntries(input.metadata),
      verificationCommands: normalizeVerificationCommands(input.verificationCommands),
    }),
    name: normalizedName && normalizedName.length > 0 ? normalizedName : basename(repoPath),
    repoPath,
    status: "paused",
    updatedAt: timestamp,
  };

  upsertProject(context, project);

  return project;
}

export function parseProjectMetadata(
  project: Pick<IProjectRecord, "metadataJson"> & Partial<Pick<IProjectRecord, "status">>,
): IProjectMetadata {
  const parsedJson = parseJsonObject(project.metadataJson);
  const metadataSource =
    parsedJson.metadata !== undefined && isStringRecord(parsedJson.metadata)
      ? parsedJson.metadata
      : collectLegacyMetadata(parsedJson);
  const verificationCommands =
    parsedJson.verificationCommands !== undefined
      ? normalizeVerificationCommands(parsedJson.verificationCommands)
      : typeof parsedJson.verificationCommand === "string"
        ? normalizeVerificationCommands([parsedJson.verificationCommand])
        : [];

  return {
    approvalPolicy: normalizeApprovalPolicy(parsedJson.approvalPolicy),
    executionState: normalizeExecutionState(
      parsedJson.executionState,
      project.status !== undefined ? { status: project.status } : undefined,
    ),
    metadata: normalizeMetadataEntries(metadataSource),
    verificationCommands,
  };
}

export function serializeProjectMetadata(metadata: IProjectMetadata): string {
  return JSON.stringify({
    approvalPolicy: normalizeApprovalPolicy(metadata.approvalPolicy),
    executionState: normalizeExecutionState(metadata.executionState),
    metadata: normalizeMetadataEntries(metadata.metadata),
    verificationCommands: normalizeVerificationCommands(metadata.verificationCommands),
  });
}

export function updateProjectMetadata(
  context: IContext,
  input: IUpdateProjectMetadataInput,
): IProjectRecord {
  const project = getProjectById(context, input.projectId);

  if (project === null) {
    throw new ProjectRegistrationError(`Missing project ${input.projectId}`);
  }

  const nextRepoPath =
    input.repoPath !== undefined ? normalizeLocalRepoPath(input.repoPath) : project.repoPath;

  if (
    nextRepoPath !== project.repoPath &&
    listProjects(context).some(
      (existingProject) =>
        existingProject.id !== project.id && existingProject.repoPath === nextRepoPath,
    )
  ) {
    throw new ProjectRegistrationError(`Project is already registered for path: ${nextRepoPath}`);
  }

  const updatedProject: IProjectRecord = {
    ...project,
    ...(input.name !== undefined ? { name: input.name.trim() || project.name } : {}),
    ...(input.defaultBranch !== undefined
      ? input.defaultBranch.trim().length > 0
        ? { defaultBranch: input.defaultBranch.trim() }
        : {}
      : {}),
    metadataJson: serializeProjectMetadata({
      approvalPolicy: normalizeApprovalPolicy(
        input.approvalPolicy ?? parseProjectMetadata(project).approvalPolicy,
      ),
      executionState:
        input.executionState ?? parseProjectMetadata(project).executionState,
      metadata: normalizeMetadataEntries(input.metadata ?? parseProjectMetadata(project).metadata),
      verificationCommands: normalizeVerificationCommands(
        input.verificationCommands ?? parseProjectMetadata(project).verificationCommands,
      ),
    }),
    repoPath: nextRepoPath,
    ...(input.status !== undefined ? { status: input.status } : {}),
    updatedAt: new Date().toISOString(),
  };

  upsertProject(context, updatedProject);

  return updatedProject;
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

function parseJsonObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;

    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeVerificationCommands(commands: readonly string[] | unknown): string[] {
  if (!Array.isArray(commands)) {
    return [];
  }

  return commands
    .filter((command): command is string => typeof command === "string")
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
}

function normalizeApprovalPolicy(
  approvalPolicy: Partial<IProjectApprovalPolicy> | unknown,
): IProjectApprovalPolicy {
  const resolvedApprovalPolicy = isObjectRecord(approvalPolicy) ? approvalPolicy : {};

  return {
    requireApprovalForHighRiskTasks:
      typeof resolvedApprovalPolicy.requireApprovalForHighRiskTasks === "boolean"
        ? resolvedApprovalPolicy.requireApprovalForHighRiskTasks
        : DEFAULT_PROJECT_APPROVAL_POLICY.requireApprovalForHighRiskTasks,
    requireApprovalForNewBacklogItems:
      typeof resolvedApprovalPolicy.requireApprovalForNewBacklogItems === "boolean"
        ? resolvedApprovalPolicy.requireApprovalForNewBacklogItems
        : DEFAULT_PROJECT_APPROVAL_POLICY.requireApprovalForNewBacklogItems,
    requireApprovalForScopeChanges:
      typeof resolvedApprovalPolicy.requireApprovalForScopeChanges === "boolean"
        ? resolvedApprovalPolicy.requireApprovalForScopeChanges
        : DEFAULT_PROJECT_APPROVAL_POLICY.requireApprovalForScopeChanges,
  };
}

function normalizeExecutionState(
  executionState: unknown,
  project?: Pick<IProjectRecord, "status">,
): ProjectExecutionState {
  switch (executionState) {
    case "active":
    case "paused":
    case "blocked":
    case "waiting_for_credit":
    case "waiting_for_human":
      return executionState;
    default:
      return project?.status === "active" ? "active" : DEFAULT_PROJECT_EXECUTION_STATE;
  }
}

function normalizeMetadataEntries(
  metadata: Readonly<Record<string, string>> | unknown,
): Record<string, string> {
  if (!isStringRecord(metadata)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata)
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
}

function collectLegacyMetadata(metadataJson: Record<string, unknown>): Record<string, string> {
  const metadataEntries: Record<string, string> = {};

  for (const [key, value] of Object.entries(metadataJson)) {
    if (
      key === "approvalPolicy" ||
      key === "verificationCommand" ||
      key === "verificationCommands"
    ) {
      continue;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      metadataEntries[key] = value.trim();
    }
  }

  return metadataEntries;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObjectRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

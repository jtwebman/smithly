import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import {
  createConfig,
  type ApprovalRequester,
  type BlockerType,
  type IBacklogItemRecord,
  type IProjectRecord,
  type MemoryNoteType,
} from "@smithly/core";
import {
  addBacklogDependency,
  approveBootstrapBacklogItem,
  createContext,
  createBootstrapBacklogItem,
  createDraftBacklogItemFromPlanning,
  ensureProjectPlanningThread,
  explainWhyBacklogItemIsNext,
  finalizeBootstrapProject,
  getBacklogItemById,
  getBootstrapMvpPlan,
  getProjectById,
  listApprovalsForProject,
  listBacklogDependencyLinksForProject,
  listBacklogItemsForProject,
  listBlockersForProject,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  listProjects,
  listTaskRunsForProject,
  listWorkerSessionsForProject,
  markBacklogItemStaleFromPlanning,
  mergeDuplicateBacklogItemsFromPlanning,
  parseProjectMetadata,
  registerLocalProject,
  removePendingBacklogItemFromPlanning,
  removeBacklogDependency,
  reorderPendingBacklogItems,
  reprioritizeBacklogItemForPlanning,
  reviseBacklogItemFromPlanning,
  splitBacklogItemFromPlanning,
  startCodingTask,
  upsertApproval,
  upsertBacklogItem,
  upsertBlocker,
  upsertMemoryNote,
  upsertReviewRun,
  upsertTaskRun,
  upsertVerificationRun,
  upsertBootstrapMvpPlan,
  updateProjectMetadata,
  type IStorageContext,
} from "@smithly/storage";

export interface ISmithlyMcpEnvironment {
  readonly attachScope: "backlog_item" | "global" | "project";
  readonly dataDirectory: string;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly backlogItemId?: string;
}

export function createSmithlyMcpContext(environment: ISmithlyMcpEnvironment): IStorageContext {
  return createContext({
    config: createConfig({
      dataDirectory: environment.dataDirectory,
    }),
  });
}

export function createSmithlyMcpServer(
  context: IStorageContext,
  environment: ISmithlyMcpEnvironment,
): McpServer {
  const server = new McpServer({
    name: "smithly",
    version: "0.1.0",
  });

  server.registerResource(
    "current-attach-context",
    "smithly://attach/current",
    {
      description: "Current Smithly MCP attach scope for this session.",
      mimeType: "application/json",
      title: "Current Attach Context",
    },
    async () =>
      readJsonResource("smithly://attach/current", {
        attachScope: environment.attachScope,
        backlogItemId: environment.backlogItemId ?? null,
        projectId: environment.projectId ?? null,
        threadId: environment.threadId ?? null,
      }),
  );

  server.registerResource(
    "current-project",
    "smithly://project/current",
    {
      description: "Current Smithly project context for the active planning session.",
      mimeType: "application/json",
      title: "Current Project",
    },
    async () =>
      readJsonResource("smithly://project/current", buildProjectSnapshot(context, environment)),
  );

  server.registerResource(
    "current-backlog-item",
    "smithly://backlog/current",
    {
      description: "Current Smithly backlog item selected for task planning.",
      mimeType: "application/json",
      title: "Current Backlog Item",
    },
    async () =>
      readJsonResource("smithly://backlog/current", buildBacklogSnapshot(context, environment)),
  );

  server.registerTool(
    "inspect_bootstrap_target_folder",
    {
      description:
        "Inspect and normalize a candidate bootstrap target folder before creating or adopting a Smithly project.",
      inputSchema: {
        intent: z
          .enum(["create", "adopt"])
          .describe("Whether the operator intends to create a new repo or adopt an existing one."),
        targetFolderPath: z
          .string()
          .min(1)
          .describe("Candidate target folder path chosen during bootstrap."),
      },
      outputSchema: {
        canAdoptProject: z.boolean(),
        canCreateInParent: z.boolean(),
        exists: z.boolean(),
        intent: z.string(),
        isDirectory: z.boolean(),
        isEmptyDirectory: z.boolean(),
        looksLikeGitWorkingTree: z.boolean(),
        normalizedTargetFolderPath: z.string(),
        parentDirectoryPath: z.string(),
        parentExists: z.boolean(),
      },
    },
    async ({ intent, targetFolderPath }) => {
      const targetFolder = inspectBootstrapTargetFolder(targetFolderPath);
      const structuredContent = {
        canAdoptProject: targetFolder.isDirectory && targetFolder.looksLikeGitWorkingTree,
        canCreateInParent: targetFolder.parentExists,
        exists: targetFolder.exists,
        intent,
        isDirectory: targetFolder.isDirectory,
        isEmptyDirectory: targetFolder.isEmptyDirectory,
        looksLikeGitWorkingTree: targetFolder.looksLikeGitWorkingTree,
        normalizedTargetFolderPath: targetFolder.normalizedTargetFolderPath,
        parentDirectoryPath: targetFolder.parentDirectoryPath,
        parentExists: targetFolder.parentExists,
      };

      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "create_project_from_bootstrap",
    {
      description:
        "Register a newly created local git repo as a Smithly project after the operator has explicitly confirmed the bootstrap direction.",
      inputSchema: {
        defaultBranch: z
          .string()
          .min(1)
          .optional()
          .describe("Optional default branch to persist on the new project record."),
        name: z.string().min(1).optional().describe("Project name shown in Smithly."),
        operatorConfirmed: z
          .boolean()
          .describe("Must be true before Smithly will persist the project record."),
        repoPath: z.string().min(1).describe("Path to the newly created local git working tree."),
        verificationCommands: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional pinned verification commands for the new project."),
      },
      outputSchema: {
        project: z.object({
          id: z.string(),
          name: z.string(),
          repoPath: z.string(),
          status: z.string(),
        }),
      },
    },
    async ({ defaultBranch, name, operatorConfirmed, repoPath, verificationCommands }) => {
      ensureBootstrapConfirmed(operatorConfirmed);
      const project = registerProjectFromBootstrap(context, {
        ...(defaultBranch !== undefined ? { defaultBranch } : {}),
        mode: "create",
        ...(name !== undefined ? { name } : {}),
        repoPath,
        ...(verificationCommands !== undefined ? { verificationCommands } : {}),
      });
      const structuredContent = {
        project: summarizeProject(project),
      };

      return {
        content: [
          {
            text: `Registered Smithly project ${project.name} (${project.id}) from bootstrap.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "adopt_project_from_bootstrap",
    {
      description:
        "Register an existing local git repo as a Smithly project after the operator has explicitly confirmed adoption.",
      inputSchema: {
        defaultBranch: z
          .string()
          .min(1)
          .optional()
          .describe("Optional default branch to persist on the adopted project record."),
        name: z.string().min(1).optional().describe("Project name shown in Smithly."),
        operatorConfirmed: z
          .boolean()
          .describe("Must be true before Smithly will persist the project record."),
        repoPath: z
          .string()
          .min(1)
          .describe("Path to the existing local git working tree to adopt."),
        verificationCommands: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional pinned verification commands for the adopted project."),
      },
      outputSchema: {
        project: z.object({
          id: z.string(),
          name: z.string(),
          repoPath: z.string(),
          status: z.string(),
        }),
      },
    },
    async ({ defaultBranch, name, operatorConfirmed, repoPath, verificationCommands }) => {
      ensureBootstrapConfirmed(operatorConfirmed);
      const project = registerProjectFromBootstrap(context, {
        ...(defaultBranch !== undefined ? { defaultBranch } : {}),
        mode: "adopt",
        ...(name !== undefined ? { name } : {}),
        repoPath,
        ...(verificationCommands !== undefined ? { verificationCommands } : {}),
      });
      const structuredContent = {
        project: summarizeProject(project),
      };

      return {
        content: [
          {
            text: `Adopted existing repo ${project.name} (${project.id}) into Smithly.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "get_bootstrap_project_state",
    {
      description:
        "Get bootstrap planning state for a project, including the MVP plan, backlog drafts, and bootstrap metadata.",
      inputSchema: {
        projectId: z.string().describe("Project to inspect during bootstrap planning."),
      },
      outputSchema: {
        approvedBacklogCount: z.number(),
        bootstrapState: z.string().nullable(),
        draftBacklogCount: z.number(),
        hasMvpPlan: z.boolean(),
        mvpPlan: z.string().nullable(),
        readyBacklogCount: z.number(),
        project: z.object({
          id: z.string(),
          name: z.string(),
          repoPath: z.string(),
          status: z.string(),
        }),
      },
    },
    async ({ projectId }) => {
      const project = requireProject(context, projectId);
      const metadata = parseProjectMetadata(project).metadata;
      const backlogItems = listBacklogItemsForProject(context, projectId);
      const mvpPlan = getBootstrapMvpPlan(context, projectId);
      const structuredContent = {
        approvedBacklogCount: backlogItems.filter(
          (backlogItem) => backlogItem.status === "approved",
        ).length,
        bootstrapState: metadata.bootstrapState ?? null,
        draftBacklogCount: backlogItems.filter((backlogItem) => backlogItem.status === "draft")
          .length,
        hasMvpPlan: mvpPlan !== null,
        mvpPlan: mvpPlan?.bodyText ?? null,
        readyBacklogCount: backlogItems.filter((backlogItem) => backlogItem.readiness === "ready")
          .length,
        project: summarizeProject(project),
      };

      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "save_bootstrap_mvp_plan",
    {
      description:
        "Save or update the MVP plan for a bootstrap project after the operator and Claude agree on the direction.",
      inputSchema: {
        planText: z.string().min(1).describe("Condensed MVP plan text for the bootstrap project."),
        projectId: z.string().describe("Project receiving the bootstrap MVP plan."),
      },
      outputSchema: {
        noteId: z.string(),
        projectId: z.string(),
        title: z.string(),
      },
    },
    async ({ planText, projectId }) => {
      const planNote = upsertBootstrapMvpPlan(context, {
        bodyText: planText,
        projectId,
      });
      const structuredContent = {
        noteId: planNote.id,
        projectId,
        title: planNote.title,
      };

      return {
        content: [
          {
            text: `Saved bootstrap MVP plan for project ${projectId}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "draft_bootstrap_backlog_item",
    {
      description:
        "Create a bootstrap backlog item from the MVP plan before the project is handed off to the main dashboard.",
      inputSchema: {
        acceptanceCriteria: z
          .array(z.string().min(1))
          .optional()
          .describe("Optional acceptance criteria for the bootstrap backlog item."),
        priority: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Optional backlog priority."),
        projectId: z.string().describe("Project receiving the bootstrap backlog item."),
        reviewMode: z.enum(["human", "ai"]).optional().describe("Optional review mode."),
        riskLevel: z.enum(["low", "medium", "high"]).optional().describe("Optional risk level."),
        scopeSummary: z.string().min(1).describe("Short scope summary for the bootstrap item."),
        title: z.string().min(1).describe("Short bootstrap backlog title."),
      },
      outputSchema: {
        backlogItem: z.object({
          id: z.string(),
          priority: z.number(),
          readiness: z.string(),
          reviewMode: z.string(),
          riskLevel: z.string(),
          status: z.string(),
          title: z.string(),
        }),
      },
    },
    async ({
      acceptanceCriteria,
      priority,
      projectId,
      reviewMode,
      riskLevel,
      scopeSummary,
      title,
    }) => {
      const backlogItem = createBootstrapBacklogItem(context, {
        ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
        ...(priority !== undefined ? { priority } : {}),
        projectId,
        ...(reviewMode !== undefined ? { reviewMode } : {}),
        ...(riskLevel !== undefined ? { riskLevel } : {}),
        scopeSummary,
        title,
      });
      const structuredContent = {
        backlogItem: summarizeBacklogItem(backlogItem),
      };

      return {
        content: [
          {
            text: `Created bootstrap backlog item ${backlogItem.title} (${backlogItem.id}).`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "approve_bootstrap_backlog_item",
    {
      description:
        "Record operator approval for a bootstrap backlog item so selected work is ready before dashboard handoff.",
      inputSchema: {
        backlogItemId: z.string().describe("Bootstrap backlog item to approve."),
        detail: z
          .string()
          .optional()
          .describe("Optional approval detail captured from the bootstrap review."),
      },
      outputSchema: {
        approvalId: z.string(),
        backlogItemId: z.string(),
        status: z.string(),
      },
    },
    async ({ backlogItemId, detail }) => {
      const result = approveBootstrapBacklogItem(context, {
        backlogItemId,
        ...(detail !== undefined ? { detail } : {}),
      });
      const structuredContent = {
        approvalId: result.approval.id,
        backlogItemId: result.backlogItem.id,
        status: result.backlogItem.status,
      };

      return {
        content: [
          {
            text: `Approved bootstrap backlog item ${result.backlogItem.title}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "finalize_bootstrap_project",
    {
      description:
        "Mark bootstrap planning complete once the MVP plan exists and at least one bootstrap backlog item has been approved.",
      inputSchema: {
        projectId: z.string().describe("Project to finalize after bootstrap planning."),
      },
      outputSchema: {
        bootstrapState: z.string().nullable(),
        project: z.object({
          id: z.string(),
          name: z.string(),
          repoPath: z.string(),
          status: z.string(),
        }),
      },
    },
    async ({ projectId }) => {
      const project = finalizeBootstrapProject(context, {
        projectId,
      });
      const metadata = parseProjectMetadata(project).metadata;
      const structuredContent = {
        bootstrapState: metadata.bootstrapState ?? null,
        project: summarizeProject(project),
      };

      return {
        content: [
          {
            text: `Finalized bootstrap planning for project ${project.name}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "list_projects",
    {
      description: "List Smithly projects available to this local control-plane service.",
      outputSchema: {
        projects: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            repoPath: z.string(),
            status: z.string(),
          }),
        ),
      },
    },
    async () => {
      const projects = listProjects(context).map((project) => summarizeProject(project));
      const structuredContent = {
        projects,
      };

      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "get_project_by_id",
    {
      description:
        "Get one Smithly project by id. Defaults to the currently attached project when present.",
      inputSchema: {
        projectId: z.string().optional().describe("Project to fetch."),
      },
      outputSchema: {
        project: z.object({
          id: z.string(),
          name: z.string(),
          repoPath: z.string(),
          status: z.string(),
        }),
      },
    },
    async ({ projectId }) => {
      const resolvedProjectId = projectId ?? requireProjectId(environment);
      const project = requireProject(context, resolvedProjectId);
      const structuredContent = {
        project: summarizeProject(project),
      };

      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "get_project_snapshot",
    {
      description:
        "Get the current project backlog, planning threads, and memory summary for this planning session.",
      outputSchema: {
        backlogCount: z.number(),
        memoryNoteCount: z.number(),
        planningThreadCount: z.number(),
        projectId: z.string(),
        projectName: z.string(),
      },
    },
    async () => {
      const projectId = requireProjectId(environment);
      const project = requireProject(context, projectId);
      const backlogItems = listBacklogItemsForProject(context, projectId);
      const memoryNotes = listMemoryNotesForProject(context, projectId);
      const planningThreads = listChatThreadsForProject(context, projectId).filter((thread) => {
        return thread.kind === "project_planning" || thread.kind === "task_planning";
      });
      const structuredContent = {
        backlogCount: backlogItems.length,
        memoryNoteCount: memoryNotes.length,
        planningThreadCount: planningThreads.length,
        projectId: project.id,
        projectName: project.name,
      };

      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "list_backlog_items",
    {
      description: "List backlog items for the current project, optionally filtered by status.",
      inputSchema: {
        statuses: z
          .array(z.enum(["draft", "approved", "in_progress", "blocked", "done", "cancelled"]))
          .optional()
          .describe("Optional backlog statuses to include."),
      },
      outputSchema: {
        backlogItems: z.array(
          z.object({
            id: z.string(),
            priority: z.number(),
            readiness: z.string(),
            reviewMode: z.string(),
            riskLevel: z.string(),
            scopeSummary: z.string(),
            status: z.string(),
            title: z.string(),
          }),
        ),
        projectId: z.string(),
      },
    },
    async ({ statuses }) => {
      const projectId = requireProjectId(environment);
      const backlogItems = listBacklogItemsForProject(context, projectId)
        .filter((backlogItem) => statuses === undefined || statuses.includes(backlogItem.status))
        .map((backlogItem) => summarizeBacklogItem(backlogItem));
      const structuredContent = {
        backlogItems,
        projectId,
      };

      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "create_draft_backlog_item",
    {
      description: "Create a new draft backlog item from the active project planning thread.",
      inputSchema: {
        scopeSummary: z
          .string()
          .min(1)
          .describe("Short scope summary for the new draft backlog item."),
        title: z.string().min(1).describe("Short title for the new draft backlog item."),
      },
      outputSchema: {
        backlogItemId: z.string(),
        status: z.string(),
        title: z.string(),
      },
    },
    async ({ scopeSummary, title }) => {
      const projectId = requireProjectId(environment);
      const threadId = requireThreadId(environment);
      const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
        projectId,
        scopeSummary,
        sourceThreadId: threadId,
        title,
      });
      const structuredContent = {
        backlogItemId: createdBacklogItem.id,
        status: createdBacklogItem.status,
        title: createdBacklogItem.title,
      };

      return {
        content: [
          {
            text: `Created draft backlog item ${createdBacklogItem.title} (${createdBacklogItem.id}).`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "remove_pending_backlog_item",
    {
      description:
        "Remove a pending backlog item from active planning without mutating active or completed work.",
      inputSchema: {
        backlogItemId: z.string().describe("Pending backlog item to remove from the backlog."),
        noteText: z
          .string()
          .optional()
          .describe("Optional planning note recorded alongside the removal."),
      },
      outputSchema: {
        backlogItem: z.object({
          id: z.string(),
          priority: z.number(),
          readiness: z.string(),
          reviewMode: z.string(),
          riskLevel: z.string(),
          scopeSummary: z.string(),
          status: z.string(),
          title: z.string(),
        }),
      },
    },
    async ({ backlogItemId, noteText }) => {
      const projectId = requireProjectId(environment);
      const backlogItem = removePendingBacklogItemFromPlanning(context, {
        backlogItemId: requireBacklogItem(context, projectId, backlogItemId).id,
        ...(noteText !== undefined ? { noteText } : {}),
        ...(environment.threadId !== undefined ? { sourceThreadId: environment.threadId } : {}),
      });
      const structuredContent = {
        backlogItem: summarizeBacklogItem(backlogItem),
      };

      return {
        content: [
          {
            text: `Removed pending backlog item ${backlogItem.title} from the active planning set.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "split_backlog_item",
    {
      description:
        "Split one oversized pending backlog item into multiple smaller planning items and retire the original draft from the queue.",
      inputSchema: {
        backlogItemId: z.string().describe("Oversized backlog item to split."),
        noteText: z
          .string()
          .optional()
          .describe("Optional planning note recorded alongside the split."),
        splitItems: z
          .array(
            z.object({
              acceptanceCriteria: z
                .array(z.string().min(1))
                .optional()
                .describe("Optional acceptance criteria for the split backlog item."),
              priority: z
                .number()
                .int()
                .optional()
                .describe("Optional priority override for the split backlog item."),
              readiness: z
                .enum(["not_ready", "ready"])
                .optional()
                .describe("Optional readiness override for the split backlog item."),
              reviewMode: z.enum(["human", "ai"]).optional().describe("Optional review mode."),
              riskLevel: z
                .enum(["low", "medium", "high"])
                .optional()
                .describe("Optional risk level."),
              scopeSummary: z
                .string()
                .min(1)
                .describe("Short scope summary for the split backlog item."),
              status: z
                .enum(["draft", "approved"])
                .optional()
                .describe("Optional status for the split backlog item."),
              title: z.string().min(1).describe("Short title for the split backlog item."),
            }),
          )
          .min(2)
          .describe("Two or more smaller backlog items that replace the oversized item."),
      },
      outputSchema: {
        originalBacklogItem: z.object({
          id: z.string(),
          priority: z.number(),
          readiness: z.string(),
          reviewMode: z.string(),
          riskLevel: z.string(),
          scopeSummary: z.string(),
          status: z.string(),
          title: z.string(),
        }),
        splitBacklogItems: z.array(
          z.object({
            id: z.string(),
            priority: z.number(),
            readiness: z.string(),
            reviewMode: z.string(),
            riskLevel: z.string(),
            scopeSummary: z.string(),
            status: z.string(),
            title: z.string(),
          }),
        ),
      },
    },
    async ({ backlogItemId, noteText, splitItems }) => {
      const projectId = requireProjectId(environment);
      const result = splitBacklogItemFromPlanning(context, {
        backlogItemId: requireBacklogItem(context, projectId, backlogItemId).id,
        ...(noteText !== undefined ? { noteText } : {}),
        ...(environment.threadId !== undefined ? { sourceThreadId: environment.threadId } : {}),
        splitItems: splitItems.map((splitItem) => ({
          ...(splitItem.acceptanceCriteria !== undefined
            ? { acceptanceCriteria: splitItem.acceptanceCriteria }
            : {}),
          ...(splitItem.priority !== undefined ? { priority: splitItem.priority } : {}),
          ...(splitItem.readiness !== undefined ? { readiness: splitItem.readiness } : {}),
          ...(splitItem.reviewMode !== undefined ? { reviewMode: splitItem.reviewMode } : {}),
          ...(splitItem.riskLevel !== undefined ? { riskLevel: splitItem.riskLevel } : {}),
          scopeSummary: splitItem.scopeSummary,
          ...(splitItem.status !== undefined ? { status: splitItem.status } : {}),
          title: splitItem.title,
        })),
      });
      const structuredContent = {
        originalBacklogItem: summarizeBacklogItem(result.originalBacklogItem),
        splitBacklogItems: result.splitBacklogItems.map((backlogItem) =>
          summarizeBacklogItem(backlogItem),
        ),
      };

      return {
        content: [
          {
            text: `Split backlog item ${result.originalBacklogItem.title} into ${result.splitBacklogItems.length} smaller item(s).`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "merge_duplicate_backlog_items",
    {
      description:
        "Merge duplicate pending backlog items into one retained item and cancel the duplicates after rolling their scope into the target.",
      inputSchema: {
        duplicateBacklogItemIds: z
          .array(z.string().min(1))
          .min(1)
          .describe("Duplicate backlog items that should be merged into the target."),
        noteText: z
          .string()
          .optional()
          .describe("Optional planning note recorded alongside the merge."),
        targetBacklogItemId: z
          .string()
          .describe("Backlog item that should survive the duplicate merge."),
      },
      outputSchema: {
        cancelledBacklogItems: z.array(
          z.object({
            id: z.string(),
            priority: z.number(),
            readiness: z.string(),
            reviewMode: z.string(),
            riskLevel: z.string(),
            scopeSummary: z.string(),
            status: z.string(),
            title: z.string(),
          }),
        ),
        mergedBacklogItem: z.object({
          id: z.string(),
          priority: z.number(),
          readiness: z.string(),
          reviewMode: z.string(),
          riskLevel: z.string(),
          scopeSummary: z.string(),
          status: z.string(),
          title: z.string(),
        }),
      },
    },
    async ({ duplicateBacklogItemIds, noteText, targetBacklogItemId }) => {
      const projectId = requireProjectId(environment);
      const result = mergeDuplicateBacklogItemsFromPlanning(context, {
        duplicateBacklogItemIds: duplicateBacklogItemIds.map((backlogItemId) => {
          return requireBacklogItem(context, projectId, backlogItemId).id;
        }),
        ...(noteText !== undefined ? { noteText } : {}),
        ...(environment.threadId !== undefined ? { sourceThreadId: environment.threadId } : {}),
        targetBacklogItemId: requireBacklogItem(context, projectId, targetBacklogItemId).id,
      });
      const structuredContent = {
        cancelledBacklogItems: result.cancelledBacklogItems.map((backlogItem) =>
          summarizeBacklogItem(backlogItem),
        ),
        mergedBacklogItem: summarizeBacklogItem(result.mergedBacklogItem),
      };

      return {
        content: [
          {
            text: `Merged ${result.cancelledBacklogItems.length} duplicate backlog item(s) into ${result.mergedBacklogItem.title}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "mark_backlog_item_stale",
    {
      description:
        "Mark a pending backlog item as stale so it drops out of the active execution queue without touching completed work.",
      inputSchema: {
        backlogItemId: z.string().describe("Pending backlog item to mark stale."),
        noteText: z
          .string()
          .optional()
          .describe("Optional stale reason recorded alongside the change."),
      },
      outputSchema: {
        backlogItem: z.object({
          id: z.string(),
          priority: z.number(),
          readiness: z.string(),
          reviewMode: z.string(),
          riskLevel: z.string(),
          scopeSummary: z.string(),
          status: z.string(),
          title: z.string(),
        }),
      },
    },
    async ({ backlogItemId, noteText }) => {
      const projectId = requireProjectId(environment);
      const backlogItem = markBacklogItemStaleFromPlanning(context, {
        backlogItemId: requireBacklogItem(context, projectId, backlogItemId).id,
        ...(noteText !== undefined ? { noteText } : {}),
        ...(environment.threadId !== undefined ? { sourceThreadId: environment.threadId } : {}),
      });
      const structuredContent = {
        backlogItem: summarizeBacklogItem(backlogItem),
      };

      return {
        content: [
          {
            text: `Marked backlog item ${backlogItem.title} as stale.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "explain_backlog_priority",
    {
      description:
        "Explain whether a backlog item is the next runnable task, using Smithly's current approval, readiness, blocker, and dependency rules.",
      inputSchema: {
        backlogItemId: z
          .string()
          .optional()
          .describe("Backlog item to explain. Defaults to the attached backlog item when present."),
      },
      outputSchema: {
        activeTaskRunId: z.string().nullable(),
        backlogItemId: z.string(),
        blockingReasons: z.array(z.string()),
        explanation: z.string(),
        higherPriorityRunnableBacklogItemIds: z.array(z.string()),
        isNext: z.boolean(),
        readyForExecution: z.boolean(),
      },
    },
    async ({ backlogItemId }) => {
      const projectId = requireProjectId(environment);
      const explanation = explainWhyBacklogItemIsNext(context, {
        backlogItemId: requireBacklogItem(
          context,
          projectId,
          backlogItemId ?? environment.backlogItemId,
        ).id,
      });
      const structuredContent = {
        activeTaskRunId: explanation.activeTaskRunId,
        backlogItemId: explanation.backlogItemId,
        blockingReasons: [...explanation.blockingReasons],
        explanation: explanation.explanation,
        higherPriorityRunnableBacklogItemIds: [...explanation.higherPriorityRunnableBacklogItemIds],
        isNext: explanation.isNext,
        readyForExecution: explanation.readyForExecution,
      };

      return {
        content: [
          {
            text: explanation.explanation,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "claim_backlog_item",
    {
      description:
        "Claim a backlog item for execution, create a task run, and move the backlog item into progress.",
      inputSchema: {
        assignedWorker: z
          .enum(["claude", "codex"])
          .describe("Worker that should own the claimed task run."),
        backlogItemId: z
          .string()
          .optional()
          .describe("Backlog item to claim. Defaults to the task-planning context item."),
        status: z
          .enum(["queued", "running"])
          .optional()
          .describe("Initial task-run status. Defaults to queued."),
        summaryText: z
          .string()
          .optional()
          .describe("Optional task-run summary describing the claimed work."),
      },
      outputSchema: {
        assignedWorker: z.string(),
        backlogItemId: z.string(),
        status: z.string(),
        taskRunId: z.string(),
      },
    },
    async ({ assignedWorker, backlogItemId, status, summaryText }) => {
      const projectId = requireProjectId(environment);
      const backlogItem = requireBacklogItem(
        context,
        projectId,
        backlogItemId ?? environment.backlogItemId,
      );
      const taskRun = startCodingTask(context, {
        assignedWorker,
        backlogItemId: backlogItem.id,
        ...(status !== undefined ? { initialStatus: status } : {}),
        ...(summaryText !== undefined ? { summaryText } : {}),
      });
      const structuredContent = {
        assignedWorker: taskRun.assignedWorker,
        backlogItemId: taskRun.backlogItemId,
        status: taskRun.status,
        taskRunId: taskRun.id,
      };

      return {
        content: [
          {
            text: `Claimed backlog item ${backlogItem.title} as ${taskRun.id} for ${taskRun.assignedWorker}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "start_coding_task",
    {
      description: "Start or resume a Codex coding task for the current backlog item.",
      inputSchema: {
        backlogItemId: z
          .string()
          .optional()
          .describe("Backlog item to code. Defaults to the task-planning context item."),
        summaryText: z
          .string()
          .optional()
          .describe("Optional task summary recorded on the Codex task run."),
      },
      outputSchema: {
        assignedWorker: z.string(),
        backlogItemId: z.string(),
        status: z.string(),
        taskRunId: z.string(),
      },
    },
    async ({ backlogItemId, summaryText }) => {
      const projectId = requireProjectId(environment);
      const taskRun = startCodingTask(context, {
        assignedWorker: "codex",
        backlogItemId: requireBacklogItem(
          context,
          projectId,
          backlogItemId ?? environment.backlogItemId,
        ).id,
        ...(summaryText !== undefined ? { summaryText } : {}),
      });
      const structuredContent = {
        assignedWorker: taskRun.assignedWorker,
        backlogItemId: taskRun.backlogItemId,
        status: taskRun.status,
        taskRunId: taskRun.id,
      };

      return {
        content: [
          {
            text: `Started Codex task ${taskRun.id} for backlog item ${taskRun.backlogItemId}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "list_task_runs",
    {
      description:
        "List task runs for the current project, including Codex task status when present.",
      inputSchema: {
        assignedWorker: z.enum(["claude", "codex"]).optional().describe("Optional worker filter."),
        statuses: z
          .array(
            z.enum([
              "queued",
              "running",
              "blocked",
              "awaiting_review",
              "done",
              "failed",
              "cancelled",
            ]),
          )
          .optional()
          .describe("Optional task-run status filter."),
      },
      outputSchema: {
        taskRuns: z.array(
          z.object({
            assignedWorker: z.string(),
            backlogItemId: z.string(),
            status: z.string(),
            summaryText: z.string(),
            taskRunId: z.string(),
            transcriptRef: z.string().nullable(),
            workerSessionId: z.string().nullable(),
            workerSessionStatus: z.string().nullable(),
          }),
        ),
      },
    },
    async ({ assignedWorker, statuses }) => {
      const projectId = requireProjectId(environment);
      const workerSessions = listWorkerSessionsForProject(context, projectId);
      const taskRuns = listTaskRunsForProject(context, projectId)
        .filter(
          (taskRun) => assignedWorker === undefined || taskRun.assignedWorker === assignedWorker,
        )
        .filter((taskRun) => statuses === undefined || statuses.includes(taskRun.status))
        .map((taskRun) => {
          const workerSession = taskRun.workerSessionId
            ? workerSessions.find((session) => session.id === taskRun.workerSessionId)
            : undefined;

          return {
            assignedWorker: taskRun.assignedWorker,
            backlogItemId: taskRun.backlogItemId,
            status: taskRun.status,
            summaryText: taskRun.summaryText ?? "",
            taskRunId: taskRun.id,
            transcriptRef: workerSession?.transcriptRef ?? null,
            workerSessionId: taskRun.workerSessionId ?? null,
            workerSessionStatus: workerSession?.status ?? null,
          };
        });
      const structuredContent = { taskRuns };

      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "list_backlog_dependencies",
    {
      description: "List explicit backlog dependency links for the current project.",
      inputSchema: {
        backlogItemId: z
          .string()
          .optional()
          .describe("Optional backlog item filter for blocking or blocked links."),
      },
      outputSchema: {
        dependencies: z.array(
          z.object({
            blockedBacklogItemId: z.string(),
            blockingBacklogItemId: z.string(),
            createdAt: z.string(),
            projectId: z.string(),
            updatedAt: z.string(),
          }),
        ),
      },
    },
    async ({ backlogItemId }) => {
      const projectId = requireProjectId(environment);
      const dependencies = listBacklogDependencyLinksForProject(context, projectId).filter(
        (dependency) => {
          return (
            backlogItemId === undefined ||
            dependency.blockedBacklogItemId === backlogItemId ||
            dependency.blockingBacklogItemId === backlogItemId
          );
        },
      );
      const structuredContent = { dependencies };

      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "add_backlog_dependency",
    {
      description: "Record that one backlog item explicitly blocks another within the same project.",
      inputSchema: {
        blockedBacklogItemId: z.string().describe("Backlog item that must wait."),
        blockingBacklogItemId: z.string().describe("Backlog item that must finish first."),
        noteText: z
          .string()
          .optional()
          .describe("Optional planning note recorded alongside the dependency link."),
      },
      outputSchema: {
        dependency: z.object({
          blockedBacklogItemId: z.string(),
          blockingBacklogItemId: z.string(),
          createdAt: z.string(),
          projectId: z.string(),
          updatedAt: z.string(),
        }),
      },
    },
    async ({ blockedBacklogItemId, blockingBacklogItemId, noteText }) => {
      const projectId = requireProjectId(environment);
      const dependency = addBacklogDependency(context, {
        blockedBacklogItemId: requireBacklogItem(context, projectId, blockedBacklogItemId).id,
        blockingBacklogItemId: requireBacklogItem(context, projectId, blockingBacklogItemId).id,
        ...(noteText !== undefined ? { noteText } : {}),
        ...(environment.threadId !== undefined ? { sourceThreadId: environment.threadId } : {}),
      });
      const structuredContent = { dependency };

      return {
        content: [
          {
            text: `Linked backlog dependency ${blockingBacklogItemId} -> ${blockedBacklogItemId}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "remove_backlog_dependency",
    {
      description: "Remove an explicit backlog dependency link from the current project.",
      inputSchema: {
        blockedBacklogItemId: z.string().describe("Backlog item that was waiting."),
        blockingBacklogItemId: z.string().describe("Backlog item that was blocking it."),
        noteText: z
          .string()
          .optional()
          .describe("Optional planning note recorded alongside the dependency removal."),
      },
      outputSchema: {
        removed: z.boolean(),
      },
    },
    async ({ blockedBacklogItemId, blockingBacklogItemId, noteText }) => {
      const projectId = requireProjectId(environment);
      const removed = removeBacklogDependency(context, {
        blockedBacklogItemId: requireBacklogItem(context, projectId, blockedBacklogItemId).id,
        blockingBacklogItemId: requireBacklogItem(context, projectId, blockingBacklogItemId).id,
        ...(noteText !== undefined ? { noteText } : {}),
        ...(environment.threadId !== undefined ? { sourceThreadId: environment.threadId } : {}),
      });
      const structuredContent = { removed };

      return {
        content: [
          {
            text: removed
              ? `Removed backlog dependency ${blockingBacklogItemId} -> ${blockedBacklogItemId}.`
              : `No backlog dependency existed for ${blockingBacklogItemId} -> ${blockedBacklogItemId}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "reprioritize_backlog_item",
    {
      description:
        "Update the priority of a pending backlog item during planning without mutating active or completed work.",
      inputSchema: {
        backlogItemId: z.string().describe("Pending backlog item to reprioritize."),
        noteText: z
          .string()
          .optional()
          .describe("Optional planning note recorded alongside the reprioritization."),
        priority: z.number().int().describe("New relative priority for the pending backlog item."),
      },
      outputSchema: {
        backlogItem: z.object({
          id: z.string(),
          priority: z.number(),
          readiness: z.string(),
          reviewMode: z.string(),
          riskLevel: z.string(),
          scopeSummary: z.string(),
          status: z.string(),
          title: z.string(),
        }),
      },
    },
    async ({ backlogItemId, noteText, priority }) => {
      const projectId = requireProjectId(environment);
      const backlogItem = reprioritizeBacklogItemForPlanning(context, {
        backlogItemId: requireBacklogItem(context, projectId, backlogItemId).id,
        ...(noteText !== undefined ? { noteText } : {}),
        priority,
        ...(environment.threadId !== undefined ? { sourceThreadId: environment.threadId } : {}),
      });
      const structuredContent = {
        backlogItem: summarizeBacklogItem(backlogItem),
      };

      return {
        content: [
          {
            text: `Reprioritized backlog item ${backlogItem.title} to priority ${backlogItem.priority}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "reorder_pending_backlog_items",
    {
      description:
        "Reorder pending backlog items during planning without touching the active task or completed work.",
      inputSchema: {
        backlogItemIds: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "Pending backlog items to move to the front of the pending queue, in the exact desired order.",
          ),
        noteText: z
          .string()
          .optional()
          .describe("Optional planning note recorded alongside the reorder action."),
      },
      outputSchema: {
        backlogItems: z.array(
          z.object({
            id: z.string(),
            priority: z.number(),
            readiness: z.string(),
            reviewMode: z.string(),
            riskLevel: z.string(),
            scopeSummary: z.string(),
            status: z.string(),
            title: z.string(),
          }),
        ),
        projectId: z.string(),
      },
    },
    async ({ backlogItemIds, noteText }) => {
      const projectId = requireProjectId(environment);
      const backlogItems = reorderPendingBacklogItems(context, {
        backlogItemIds,
        ...(noteText !== undefined ? { noteText } : {}),
        projectId,
        ...(environment.threadId !== undefined ? { sourceThreadId: environment.threadId } : {}),
      });
      const structuredContent = {
        backlogItems: backlogItems.map((backlogItem) => summarizeBacklogItem(backlogItem)),
        projectId,
      };

      return {
        content: [
          {
            text: `Reordered ${backlogItemIds.length} pending backlog item(s) for project ${projectId}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "revise_backlog_item",
    {
      description:
        "Revise the focused backlog item's scope summary and acceptance criteria from task planning.",
      inputSchema: {
        acceptanceCriteria: z
          .array(z.string().min(1))
          .min(1)
          .describe("Acceptance criteria lines for the backlog item."),
        noteText: z
          .string()
          .optional()
          .describe("Optional operator note to append to the planning thread."),
        priority: z.number().int().min(0).max(100).optional().describe("Updated backlog priority."),
        readiness: z.enum(["not_ready", "ready"]).optional().describe("Updated readiness state."),
        reviewMode: z.enum(["human", "ai"]).optional().describe("Updated review mode."),
        riskLevel: z.enum(["low", "medium", "high"]).optional().describe("Updated risk level."),
        scopeSummary: z.string().min(1).describe("Revised scope summary for the backlog item."),
        status: z
          .enum(["draft", "approved", "in_progress", "blocked", "done", "cancelled"])
          .optional()
          .describe("Updated backlog status."),
      },
      outputSchema: {
        acceptanceCriteriaCount: z.number(),
        backlogItemId: z.string(),
        priority: z.number(),
        readiness: z.string(),
        reviewMode: z.string(),
        riskLevel: z.string(),
        status: z.string(),
        title: z.string(),
      },
    },
    async ({
      acceptanceCriteria,
      noteText,
      priority,
      readiness,
      reviewMode,
      riskLevel,
      scopeSummary,
      status,
    }) => {
      const backlogItemId = environment.backlogItemId;
      const threadId = requireThreadId(environment);

      if (backlogItemId === undefined) {
        throw new Error("No backlog item is focused for this planning session.");
      }

      const revisedBacklogItem = reviseBacklogItemFromPlanning(context, {
        acceptanceCriteria,
        backlogItemId,
        ...(noteText !== undefined ? { noteText } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(readiness !== undefined ? { readiness } : {}),
        ...(reviewMode !== undefined ? { reviewMode } : {}),
        ...(riskLevel !== undefined ? { riskLevel } : {}),
        scopeSummary,
        sourceThreadId: threadId,
        ...(status !== undefined ? { status } : {}),
      });
      const structuredContent = {
        acceptanceCriteriaCount: acceptanceCriteria.length,
        backlogItemId: revisedBacklogItem.id,
        priority: revisedBacklogItem.priority,
        readiness: revisedBacklogItem.readiness,
        reviewMode: revisedBacklogItem.reviewMode,
        riskLevel: revisedBacklogItem.riskLevel,
        status: revisedBacklogItem.status,
        title: revisedBacklogItem.title,
      };

      return {
        content: [
          {
            text: `Updated backlog item ${revisedBacklogItem.title} with ${acceptanceCriteria.length} acceptance criteria, status ${revisedBacklogItem.status}, priority ${revisedBacklogItem.priority}, risk ${revisedBacklogItem.riskLevel}, review ${revisedBacklogItem.reviewMode}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "list_pending_approvals",
    {
      description: "List pending approvals for the current project.",
      outputSchema: {
        approvals: z.array(
          z.object({
            detail: z.string(),
            id: z.string(),
            status: z.string(),
            title: z.string(),
          }),
        ),
      },
    },
    async () => {
      const approvals = listApprovalsForProject(context, requireProjectId(environment))
        .filter((approval) => approval.status === "pending")
        .map((approval) => ({
          detail: approval.detail,
          id: approval.id,
          status: approval.status,
          title: approval.title,
        }));
      const structuredContent = { approvals };

      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "request_approval",
    {
      description: "Create a pending approval request for the current project or focused task.",
      inputSchema: {
        backlogItemId: z.string().optional().describe("Optional related backlog item."),
        detail: z.string().min(1).describe("Approval details for the operator."),
        requestedBy: z
          .enum(["system", "claude", "codex", "human"])
          .optional()
          .describe("Requester recorded for the approval. Defaults to claude."),
        taskRunId: z.string().optional().describe("Optional related task run."),
        title: z.string().min(1).describe("Short approval title."),
      },
      outputSchema: {
        approvalId: z.string(),
        status: z.string(),
        title: z.string(),
      },
    },
    async ({ backlogItemId, detail, requestedBy, taskRunId, title }) => {
      const projectId = requireProjectId(environment);
      const now = new Date().toISOString();
      const approvalId = `approval-${randomUUID()}`;

      if (backlogItemId !== undefined) {
        requireBacklogItem(context, projectId, backlogItemId);
      }

      if (taskRunId !== undefined) {
        requireTaskRun(context, projectId, taskRunId);
      }

      upsertApproval(context, {
        createdAt: now,
        detail,
        id: approvalId,
        projectId,
        ...(backlogItemId !== undefined ? { backlogItemId } : {}),
        ...(taskRunId !== undefined ? { taskRunId } : {}),
        requestedBy: (requestedBy ?? "claude") satisfies ApprovalRequester,
        status: "pending",
        title,
        updatedAt: now,
      });
      const structuredContent = {
        approvalId,
        status: "pending",
        title,
      };

      return {
        content: [
          {
            text: `Queued approval ${title} (${approvalId}).`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "list_open_blockers",
    {
      description: "List open blockers for the current project.",
      outputSchema: {
        blockers: z.array(
          z.object({
            blockerType: z.string(),
            detail: z.string(),
            id: z.string(),
            status: z.string(),
            title: z.string(),
          }),
        ),
      },
    },
    async () => {
      const blockers = listBlockersForProject(context, requireProjectId(environment))
        .filter((blocker) => blocker.status === "open")
        .map((blocker) => ({
          blockerType: blocker.blockerType,
          detail: blocker.detail,
          id: blocker.id,
          status: blocker.status,
          title: blocker.title,
        }));
      const structuredContent = { blockers };

      return {
        content: [
          {
            text: JSON.stringify(structuredContent, null, 2),
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "raise_blocker",
    {
      description: "Create an open blocker for the current project, backlog item, or task run.",
      inputSchema: {
        backlogItemId: z.string().optional().describe("Optional related backlog item."),
        blockerType: z
          .enum(["policy", "helper_model", "human", "system"])
          .describe("How the blocker should be classified."),
        detail: z.string().min(1).describe("Full blocker detail."),
        taskRunId: z.string().optional().describe("Optional related task run."),
        title: z.string().min(1).describe("Short blocker title."),
      },
      outputSchema: {
        blockerId: z.string(),
        status: z.string(),
        title: z.string(),
      },
    },
    async ({ backlogItemId, blockerType, detail, taskRunId, title }) => {
      const structuredContent = createBlocker(context, environment, {
        ...(backlogItemId !== undefined ? { backlogItemId } : {}),
        blockerType,
        detail,
        ...(taskRunId !== undefined ? { taskRunId } : {}),
        title,
      });

      return {
        content: [
          {
            text: `Opened blocker ${title} (${structuredContent.blockerId}).`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "resolve_blocker",
    {
      description: "Resolve an existing blocker on the current project.",
      inputSchema: {
        blockerId: z.string().min(1).describe("Blocker to resolve."),
        resolutionNote: z.string().min(1).describe("Resolution note to record."),
      },
      outputSchema: {
        blockerId: z.string(),
        resolutionNote: z.string(),
        status: z.string(),
      },
    },
    async ({ blockerId, resolutionNote }) => {
      const blocker = requireBlocker(context, requireProjectId(environment), blockerId);
      const now = new Date().toISOString();

      upsertBlocker(context, {
        ...blocker,
        resolutionNote,
        resolvedAt: now,
        status: "resolved",
        updatedAt: now,
      });
      const structuredContent = {
        blockerId,
        resolutionNote,
        status: "resolved",
      };

      return {
        content: [
          {
            text: `Resolved blocker ${blocker.title} (${blockerId}).`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "ask_human_question",
    {
      description: "Escalate a question to the operator as a human blocker.",
      inputSchema: {
        backlogItemId: z.string().optional().describe("Optional related backlog item."),
        contextText: z.string().optional().describe("Optional supporting context."),
        question: z.string().min(1).describe("Question that needs human input."),
        taskRunId: z.string().optional().describe("Optional related task run."),
        title: z.string().min(1).describe("Short title for the question."),
      },
      outputSchema: {
        blockerId: z.string(),
        status: z.string(),
        title: z.string(),
      },
    },
    async ({ backlogItemId, contextText, question, taskRunId, title }) => {
      const structuredContent = createBlocker(context, environment, {
        ...(backlogItemId !== undefined ? { backlogItemId } : {}),
        blockerType: "human",
        detail:
          contextText !== undefined && contextText.trim().length > 0
            ? `${question}\n\nContext:\n${contextText}`
            : question,
        ...(taskRunId !== undefined ? { taskRunId } : {}),
        title,
      });

      return {
        content: [
          {
            text: `Raised human question ${title} (${structuredContent.blockerId}).`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "list_memory_notes",
    {
      description: "List stored project memory notes for the current project.",
      inputSchema: {
        noteTypes: z
          .array(z.enum(["fact", "decision", "note", "session_summary"]))
          .optional()
          .describe("Optional note-type filter."),
      },
      outputSchema: {
        memoryNotes: z.array(
          z.object({
            backlogItemId: z.string().optional(),
            bodyText: z.string(),
            createdAt: z.string(),
            id: z.string(),
            noteType: z.string(),
            taskRunId: z.string().optional(),
            title: z.string(),
            updatedAt: z.string(),
          }),
        ),
        projectId: z.string(),
      },
    },
    async ({ noteTypes }) => {
      const projectId = requireProjectId(environment);
      const memoryNotes = listMemoryNotesForProject(context, projectId)
        .filter((memoryNote) => noteTypes === undefined || noteTypes.includes(memoryNote.noteType))
        .map((memoryNote) => ({
          ...(memoryNote.backlogItemId !== undefined
            ? { backlogItemId: memoryNote.backlogItemId }
            : {}),
          bodyText: memoryNote.bodyText,
          createdAt: memoryNote.createdAt,
          id: memoryNote.id,
          noteType: memoryNote.noteType,
          ...(memoryNote.taskRunId !== undefined ? { taskRunId: memoryNote.taskRunId } : {}),
          title: memoryNote.title,
          updatedAt: memoryNote.updatedAt,
        }));

      return {
        content: [
          {
            text: `Found ${memoryNotes.length} memory note(s) for ${projectId}.`,
            type: "text",
          },
        ],
        structuredContent: {
          memoryNotes,
          projectId,
        },
      };
    },
  );

  server.registerTool(
    "write_memory_note",
    {
      description: "Write a project memory note tied to the current planning thread.",
      inputSchema: {
        backlogItemId: z.string().optional().describe("Optional related backlog item."),
        bodyText: z.string().min(1).describe("Memory note body text."),
        noteType: z
          .enum(["fact", "decision", "note", "session_summary"])
          .optional()
          .describe("Memory note type. Defaults to note."),
        taskRunId: z.string().optional().describe("Optional related task run."),
        title: z.string().min(1).describe("Short memory title."),
      },
      outputSchema: {
        noteId: z.string(),
        noteType: z.string(),
        title: z.string(),
      },
    },
    async ({ backlogItemId, bodyText, noteType, taskRunId, title }) => {
      const projectId = requireProjectId(environment);
      const now = new Date().toISOString();
      const noteId = `memory-${randomUUID()}`;

      if (backlogItemId !== undefined) {
        requireBacklogItem(context, projectId, backlogItemId);
      }

      if (taskRunId !== undefined) {
        requireTaskRun(context, projectId, taskRunId);
      }

      upsertMemoryNote(context, {
        bodyText,
        createdAt: now,
        id: noteId,
        noteType: (noteType ?? "note") satisfies MemoryNoteType,
        projectId,
        ...(backlogItemId !== undefined ? { backlogItemId } : {}),
        ...(taskRunId !== undefined ? { taskRunId } : {}),
        ...(environment.threadId !== undefined ? { sourceThreadId: environment.threadId } : {}),
        title,
        updatedAt: now,
      });
      const structuredContent = {
        noteId,
        noteType: noteType ?? "note",
        title,
      };

      return {
        content: [
          {
            text: `Stored memory note ${title} (${noteId}).`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "request_verification_run",
    {
      description: "Queue a verification run for an existing task run.",
      inputSchema: {
        commandText: z.string().min(1).describe("Verification command to run."),
        summaryText: z.string().optional().describe("Optional verification summary."),
        taskRunId: z.string().min(1).describe("Task run that needs verification."),
      },
      outputSchema: {
        status: z.string(),
        taskRunId: z.string(),
        verificationRunId: z.string(),
      },
    },
    async ({ commandText, summaryText, taskRunId }) => {
      const projectId = requireProjectId(environment);
      requireTaskRun(context, projectId, taskRunId);

      const now = new Date().toISOString();
      const verificationRunId = `verification-${randomUUID()}`;

      upsertVerificationRun(context, {
        commandText,
        createdAt: now,
        id: verificationRunId,
        projectId,
        ...(summaryText !== undefined ? { summaryText } : {}),
        status: "queued",
        taskRunId,
        updatedAt: now,
      });
      const structuredContent = {
        status: "queued",
        taskRunId,
        verificationRunId,
      };

      return {
        content: [
          {
            text: `Queued verification run ${verificationRunId} for ${taskRunId}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "request_review_run",
    {
      description: "Queue a review request for an existing task run.",
      inputSchema: {
        reviewerKind: z
          .enum(["human", "claude", "codex"])
          .describe("Reviewer that should handle the review."),
        summaryText: z.string().optional().describe("Optional review request summary."),
        taskRunId: z.string().min(1).describe("Task run that needs review."),
      },
      outputSchema: {
        reviewRunId: z.string(),
        reviewerKind: z.string(),
        status: z.string(),
        taskRunId: z.string(),
      },
    },
    async ({ reviewerKind, summaryText, taskRunId }) => {
      const projectId = requireProjectId(environment);
      requireTaskRun(context, projectId, taskRunId);

      const now = new Date().toISOString();
      const reviewRunId = `review-${randomUUID()}`;

      upsertReviewRun(context, {
        createdAt: now,
        id: reviewRunId,
        projectId,
        reviewerKind,
        ...(summaryText !== undefined ? { summaryText } : {}),
        status: "queued",
        taskRunId,
        updatedAt: now,
      });
      const structuredContent = {
        reviewRunId,
        reviewerKind,
        status: "queued",
        taskRunId,
      };

      return {
        content: [
          {
            text: `Queued ${reviewerKind} review ${reviewRunId} for ${taskRunId}.`,
            type: "text",
          },
        ],
        structuredContent,
      };
    },
  );

  return server;
}

export function resolveSmithlyMcpEnvironment(environment = process.env): ISmithlyMcpEnvironment {
  const dataDirectory = environment.SMITHLY_DATA_DIRECTORY?.trim();
  const attachScope = resolveAttachScope(environment);
  const projectId = environment.SMITHLY_PROJECT_ID?.trim();
  const threadId = environment.SMITHLY_THREAD_ID?.trim();
  const backlogItemId = environment.SMITHLY_BACKLOG_ITEM_ID?.trim();

  if (!dataDirectory) {
    throw new Error("SMITHLY_DATA_DIRECTORY is required.");
  }

  if (attachScope === "project" && !projectId) {
    throw new Error("SMITHLY_PROJECT_ID is required for project MCP scope.");
  }

  if (attachScope === "backlog_item" && (!projectId || !backlogItemId)) {
    throw new Error(
      "SMITHLY_PROJECT_ID and SMITHLY_BACKLOG_ITEM_ID are required for backlog scope.",
    );
  }

  return {
    attachScope,
    ...(backlogItemId ? { backlogItemId } : {}),
    dataDirectory,
    ...(projectId ? { projectId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

interface IBootstrapTargetFolderInspection {
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly isEmptyDirectory: boolean;
  readonly looksLikeGitWorkingTree: boolean;
  readonly normalizedTargetFolderPath: string;
  readonly parentDirectoryPath: string;
  readonly parentExists: boolean;
}

interface IRegisterProjectFromBootstrapInput {
  readonly defaultBranch?: string;
  readonly mode: "adopt" | "create";
  readonly name?: string;
  readonly repoPath: string;
  readonly verificationCommands?: readonly string[];
}

function buildProjectSnapshot(
  context: IStorageContext,
  environment: ISmithlyMcpEnvironment,
): Record<string, unknown> {
  if (environment.projectId === undefined) {
    return {
      project: null,
    };
  }

  const project = requireProject(context, environment.projectId);
  const backlogItems = listBacklogItemsForProject(context, environment.projectId);
  const approvals = listApprovalsForProject(context, environment.projectId);
  const dependencies = listBacklogDependencyLinksForProject(context, environment.projectId);
  const blockers = listBlockersForProject(context, environment.projectId);
  const taskRuns = listTaskRunsForProject(context, environment.projectId);

  return {
    approvals: approvals
      .filter((approval) => approval.status === "pending")
      .map((approval) => ({
        id: approval.id,
        status: approval.status,
        title: approval.title,
      })),
    backlogItems: backlogItems.map((backlogItem) => summarizeBacklogItem(backlogItem)),
    dependencies,
    blockers: blockers
      .filter((blocker) => blocker.status === "open")
      .map((blocker) => ({
        blockerType: blocker.blockerType,
        id: blocker.id,
        title: blocker.title,
      })),
    memoryNotes: listMemoryNotesForProject(context, environment.projectId).map((memoryNote) => ({
      id: memoryNote.id,
      noteType: memoryNote.noteType,
      title: memoryNote.title,
    })),
    planningThreads: listChatThreadsForProject(context, environment.projectId).map((thread) => ({
      backlogItemId: thread.backlogItemId ?? null,
      id: thread.id,
      kind: thread.kind,
      status: thread.status,
      title: thread.title,
    })),
    project: {
      id: project.id,
      name: project.name,
      repoPath: project.repoPath,
      status: project.status,
    },
    taskRuns: taskRuns.map((taskRun) => ({
      assignedWorker: taskRun.assignedWorker,
      backlogItemId: taskRun.backlogItemId,
      id: taskRun.id,
      status: taskRun.status,
      summaryText: taskRun.summaryText ?? "",
    })),
  };
}

function buildBacklogSnapshot(
  context: IStorageContext,
  environment: ISmithlyMcpEnvironment,
): Record<string, unknown> {
  if (environment.projectId === undefined || environment.backlogItemId === undefined) {
    return {
      backlogItem: null,
    };
  }

  const backlogItem = getBacklogItemById(context, environment.backlogItemId);

  return {
    backlogItem:
      backlogItem === null
        ? null
        : {
            acceptanceCriteriaJson: backlogItem.acceptanceCriteriaJson,
            id: backlogItem.id,
            scopeSummary: backlogItem.scopeSummary ?? "",
            status: backlogItem.status,
            title: backlogItem.title,
          },
  };
}

function resolveAttachScope(environment: NodeJS.ProcessEnv): ISmithlyMcpEnvironment["attachScope"] {
  const attachScope = environment.SMITHLY_ATTACH_SCOPE?.trim();

  switch (attachScope) {
    case "global":
    case "project":
    case "backlog_item":
      return attachScope;
    default:
      return environment.SMITHLY_BACKLOG_ITEM_ID?.trim() ? "backlog_item" : "project";
  }
}

function inspectBootstrapTargetFolder(targetFolderPath: string): IBootstrapTargetFolderInspection {
  const normalizedTargetFolderPath = resolve(targetFolderPath.trim());
  const exists = existsSync(normalizedTargetFolderPath);
  const isDirectory = exists ? lstatSync(normalizedTargetFolderPath).isDirectory() : false;
  const parentDirectoryPath = exists
    ? dirname(realpathSync(normalizedTargetFolderPath))
    : resolve(dirname(normalizedTargetFolderPath));
  const parentExists =
    existsSync(parentDirectoryPath) && lstatSync(parentDirectoryPath).isDirectory();

  return {
    exists,
    isDirectory,
    isEmptyDirectory: isDirectory ? readdirSync(normalizedTargetFolderPath).length === 0 : false,
    looksLikeGitWorkingTree: isDirectory && existsSync(resolve(normalizedTargetFolderPath, ".git")),
    normalizedTargetFolderPath: exists
      ? realpathSync(normalizedTargetFolderPath)
      : normalizedTargetFolderPath,
    parentDirectoryPath,
    parentExists,
  };
}

function ensureBootstrapConfirmed(operatorConfirmed: boolean): void {
  if (!operatorConfirmed) {
    throw new Error(
      "Bootstrap project registration requires explicit operator confirmation before Smithly will persist the project.",
    );
  }
}

function registerProjectFromBootstrap(
  context: IStorageContext,
  input: IRegisterProjectFromBootstrapInput,
) {
  const project = registerLocalProject(context, {
    metadata: {
      bootstrapOrigin: input.mode,
      bootstrapState: "planning",
    },
    ...(input.name !== undefined ? { name: input.name } : {}),
    repoPath: input.repoPath,
    ...(input.verificationCommands !== undefined
      ? { verificationCommands: input.verificationCommands }
      : {}),
  });

  if (input.defaultBranch === undefined) {
    return project;
  }

  return updateProjectMetadata(context, {
    defaultBranch: input.defaultBranch,
    projectId: project.id,
  });
}

function requireProjectId(environment: ISmithlyMcpEnvironment): string {
  if (environment.projectId === undefined) {
    throw new Error(`This Smithly MCP session is attached with ${environment.attachScope} scope.`);
  }

  return environment.projectId;
}

function requireThreadId(environment: ISmithlyMcpEnvironment): string {
  if (environment.threadId === undefined) {
    throw new Error(
      `This Smithly MCP session has no planning thread for ${environment.attachScope} scope.`,
    );
  }

  return environment.threadId;
}

function readJsonResource(uri: string, payload: Record<string, unknown>): ReadResourceResult {
  return {
    contents: [
      {
        text: JSON.stringify(payload, null, 2),
        uri,
      },
    ],
  };
}

function summarizeProject(project: Pick<IProjectRecord, "id" | "name" | "repoPath" | "status">) {
  return {
    id: project.id,
    name: project.name,
    repoPath: project.repoPath,
    status: project.status,
  };
}

function requireProject(context: IStorageContext, projectId: string) {
  const project = getProjectById(context, projectId);

  if (project === null) {
    throw new Error(`Missing project ${projectId}`);
  }

  return project;
}

function requireBacklogItem(
  context: IStorageContext,
  projectId: string,
  backlogItemId: string | undefined,
) {
  if (backlogItemId === undefined) {
    throw new Error("A backlog item id is required for this tool.");
  }

  const backlogItem = getBacklogItemById(context, backlogItemId);

  if (backlogItem === null || backlogItem.projectId !== projectId) {
    throw new Error(`Missing backlog item ${backlogItemId} on project ${projectId}.`);
  }

  return backlogItem;
}

function requireTaskRun(context: IStorageContext, projectId: string, taskRunId: string) {
  const taskRun = listTaskRunsForProject(context, projectId).find(
    (candidate) => candidate.id === taskRunId,
  );

  if (taskRun === undefined) {
    throw new Error(`Missing task run ${taskRunId} on project ${projectId}.`);
  }

  return taskRun;
}

function requireBlocker(context: IStorageContext, projectId: string, blockerId: string) {
  const blocker = listBlockersForProject(context, projectId).find(
    (candidate) => candidate.id === blockerId,
  );

  if (blocker === undefined) {
    throw new Error(`Missing blocker ${blockerId} on project ${projectId}.`);
  }

  return blocker;
}

function summarizeBacklogItem(backlogItem: IBacklogItemRecord) {
  return {
    id: backlogItem.id,
    priority: backlogItem.priority,
    readiness: backlogItem.readiness,
    reviewMode: backlogItem.reviewMode,
    riskLevel: backlogItem.riskLevel,
    scopeSummary: backlogItem.scopeSummary ?? "",
    status: backlogItem.status,
    title: backlogItem.title,
  };
}

function createBlocker(
  context: IStorageContext,
  environment: ISmithlyMcpEnvironment,
  input: {
    readonly backlogItemId?: string;
    readonly blockerType: BlockerType;
    readonly detail: string;
    readonly taskRunId?: string;
    readonly title: string;
  },
): {
  readonly blockerId: string;
  readonly status: "open";
  readonly title: string;
} {
  const projectId = requireProjectId(environment);
  const now = new Date().toISOString();
  const blockerId = `blocker-${randomUUID()}`;

  if (input.backlogItemId !== undefined) {
    requireBacklogItem(context, projectId, input.backlogItemId);
  }

  if (input.taskRunId !== undefined) {
    requireTaskRun(context, projectId, input.taskRunId);
  }

  upsertBlocker(context, {
    blockerType: input.blockerType,
    createdAt: now,
    detail: input.detail,
    id: blockerId,
    projectId,
    ...(input.backlogItemId !== undefined ? { backlogItemId: input.backlogItemId } : {}),
    status: "open",
    ...(input.taskRunId !== undefined ? { taskRunId: input.taskRunId } : {}),
    title: input.title,
    updatedAt: now,
  });

  return {
    blockerId,
    status: "open",
    title: input.title,
  };
}

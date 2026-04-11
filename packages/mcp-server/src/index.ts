import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createDraftBacklogItemFromPlanning,
  getBacklogItemById,
  getProjectById,
  listBacklogItemsForProject,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  reviseBacklogItemFromPlanning,
  type IStorageContext,
} from "@smithly/storage";

export interface ISmithlyMcpEnvironment {
  readonly dataDirectory: string;
  readonly projectId: string;
  readonly threadId: string;
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
      const project = requireProject(context, environment.projectId);
      const backlogItems = listBacklogItemsForProject(context, environment.projectId);
      const memoryNotes = listMemoryNotesForProject(context, environment.projectId);
      const planningThreads = listChatThreadsForProject(context, environment.projectId).filter(
        (thread) => {
          return thread.kind === "project_planning" || thread.kind === "task_planning";
        },
      );
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
      const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
        projectId: environment.projectId,
        scopeSummary,
        sourceThreadId: environment.threadId,
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
      reviewMode,
      riskLevel,
      scopeSummary,
      status,
    }) => {
      const backlogItemId = environment.backlogItemId;

      if (backlogItemId === undefined) {
        throw new Error("No backlog item is focused for this planning session.");
      }

      const revisedBacklogItem = reviseBacklogItemFromPlanning(context, {
        acceptanceCriteria,
        backlogItemId,
        ...(noteText !== undefined ? { noteText } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(reviewMode !== undefined ? { reviewMode } : {}),
        ...(riskLevel !== undefined ? { riskLevel } : {}),
        scopeSummary,
        sourceThreadId: environment.threadId,
        ...(status !== undefined ? { status } : {}),
      });
      const structuredContent = {
        acceptanceCriteriaCount: acceptanceCriteria.length,
        backlogItemId: revisedBacklogItem.id,
        priority: revisedBacklogItem.priority,
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

  return server;
}

export function resolveSmithlyMcpEnvironment(environment = process.env): ISmithlyMcpEnvironment {
  const dataDirectory = environment.SMITHLY_DATA_DIRECTORY?.trim();
  const projectId = environment.SMITHLY_PROJECT_ID?.trim();
  const threadId = environment.SMITHLY_THREAD_ID?.trim();
  const backlogItemId = environment.SMITHLY_BACKLOG_ITEM_ID?.trim();

  if (!dataDirectory) {
    throw new Error("SMITHLY_DATA_DIRECTORY is required.");
  }

  if (!projectId) {
    throw new Error("SMITHLY_PROJECT_ID is required.");
  }

  if (!threadId) {
    throw new Error("SMITHLY_THREAD_ID is required.");
  }

  return {
    ...(backlogItemId ? { backlogItemId } : {}),
    dataDirectory,
    projectId,
    threadId,
  };
}

function buildProjectSnapshot(
  context: IStorageContext,
  environment: ISmithlyMcpEnvironment,
): Record<string, unknown> {
  const project = requireProject(context, environment.projectId);

  return {
    backlogItems: listBacklogItemsForProject(context, environment.projectId).map((backlogItem) => ({
      id: backlogItem.id,
      priority: backlogItem.priority,
      reviewMode: backlogItem.reviewMode,
      riskLevel: backlogItem.riskLevel,
      scopeSummary: backlogItem.scopeSummary ?? "",
      status: backlogItem.status,
      title: backlogItem.title,
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
  };
}

function buildBacklogSnapshot(
  context: IStorageContext,
  environment: ISmithlyMcpEnvironment,
): Record<string, unknown> {
  if (environment.backlogItemId === undefined) {
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

function requireProject(context: IStorageContext, projectId: string) {
  const project = getProjectById(context, projectId);

  if (project === null) {
    throw new Error(`Missing project ${projectId}`);
  }

  return project;
}

import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import {
  createConfig,
  type ApprovalRequester,
  type BlockerType,
  type IBacklogItemRecord,
  type MemoryNoteType,
} from "@smithly/core";
import {
  createContext,
  createDraftBacklogItemFromPlanning,
  getBacklogItemById,
  getProjectById,
  listApprovalsForProject,
  listBacklogItemsForProject,
  listBlockersForProject,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  listTaskRunsForProject,
  listWorkerSessionsForProject,
  reviseBacklogItemFromPlanning,
  startCodingTask,
  upsertApproval,
  upsertBacklogItem,
  upsertBlocker,
  upsertMemoryNote,
  upsertReviewRun,
  upsertTaskRun,
  upsertVerificationRun,
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
      const backlogItems = listBacklogItemsForProject(context, environment.projectId)
        .filter((backlogItem) => statuses === undefined || statuses.includes(backlogItem.status))
        .map((backlogItem) => summarizeBacklogItem(backlogItem));
      const structuredContent = {
        backlogItems,
        projectId: environment.projectId,
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
      const backlogItem = requireBacklogItem(
        context,
        environment.projectId,
        backlogItemId ?? environment.backlogItemId,
      );
      const now = new Date().toISOString();
      const taskRunId = `taskrun-${randomUUID()}`;
      const taskRunStatus = status ?? "queued";

      upsertBacklogItem(context, {
        ...backlogItem,
        status: "in_progress",
        updatedAt: now,
      });
      upsertTaskRun(context, {
        assignedWorker,
        backlogItemId: backlogItem.id,
        createdAt: now,
        id: taskRunId,
        projectId: environment.projectId,
        ...(summaryText !== undefined ? { summaryText } : {}),
        ...(taskRunStatus === "running" ? { startedAt: now } : {}),
        status: taskRunStatus,
        updatedAt: now,
      });
      const structuredContent = {
        assignedWorker,
        backlogItemId: backlogItem.id,
        status: taskRunStatus,
        taskRunId,
      };

      return {
        content: [
          {
            text: `Claimed backlog item ${backlogItem.title} as ${taskRunId} for ${assignedWorker}.`,
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
      const taskRun = startCodingTask(context, {
        assignedWorker: "codex",
        backlogItemId: requireBacklogItem(
          context,
          environment.projectId,
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
      const workerSessions = listWorkerSessionsForProject(context, environment.projectId);
      const taskRuns = listTaskRunsForProject(context, environment.projectId)
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
      const approvals = listApprovalsForProject(context, environment.projectId)
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
      const now = new Date().toISOString();
      const approvalId = `approval-${randomUUID()}`;

      if (backlogItemId !== undefined) {
        requireBacklogItem(context, environment.projectId, backlogItemId);
      }

      if (taskRunId !== undefined) {
        requireTaskRun(context, environment.projectId, taskRunId);
      }

      upsertApproval(context, {
        createdAt: now,
        detail,
        id: approvalId,
        projectId: environment.projectId,
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
      const blockers = listBlockersForProject(context, environment.projectId)
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
      const blocker = requireBlocker(context, environment.projectId, blockerId);
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
      const now = new Date().toISOString();
      const noteId = `memory-${randomUUID()}`;

      if (backlogItemId !== undefined) {
        requireBacklogItem(context, environment.projectId, backlogItemId);
      }

      if (taskRunId !== undefined) {
        requireTaskRun(context, environment.projectId, taskRunId);
      }

      upsertMemoryNote(context, {
        bodyText,
        createdAt: now,
        id: noteId,
        noteType: (noteType ?? "note") satisfies MemoryNoteType,
        projectId: environment.projectId,
        ...(backlogItemId !== undefined ? { backlogItemId } : {}),
        ...(taskRunId !== undefined ? { taskRunId } : {}),
        sourceThreadId: environment.threadId,
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
      requireTaskRun(context, environment.projectId, taskRunId);

      const now = new Date().toISOString();
      const verificationRunId = `verification-${randomUUID()}`;

      upsertVerificationRun(context, {
        commandText,
        createdAt: now,
        id: verificationRunId,
        projectId: environment.projectId,
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
      requireTaskRun(context, environment.projectId, taskRunId);

      const now = new Date().toISOString();
      const reviewRunId = `review-${randomUUID()}`;

      upsertReviewRun(context, {
        createdAt: now,
        id: reviewRunId,
        projectId: environment.projectId,
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
  const backlogItems = listBacklogItemsForProject(context, environment.projectId);
  const approvals = listApprovalsForProject(context, environment.projectId);
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
  const now = new Date().toISOString();
  const blockerId = `blocker-${randomUUID()}`;

  if (input.backlogItemId !== undefined) {
    requireBacklogItem(context, environment.projectId, input.backlogItemId);
  }

  if (input.taskRunId !== undefined) {
    requireTaskRun(context, environment.projectId, input.taskRunId);
  }

  upsertBlocker(context, {
    blockerType: input.blockerType,
    createdAt: now,
    detail: input.detail,
    id: blockerId,
    projectId: environment.projectId,
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

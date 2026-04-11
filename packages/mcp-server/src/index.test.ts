import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createDraftBacklogItemFromPlanning,
  createContext,
  listApprovalsForProject,
  listBacklogItemsForProject,
  listBlockersForProject,
  listMemoryNotesForProject,
  listReviewRunsForTask,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  seedInitialState,
} from "@smithly/storage";

import { createSmithlyMcpServer } from "./index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

async function connectClient(server: ReturnType<typeof createSmithlyMcpServer>) {
  const client = new Client({
    name: "smithly-test-client",
    version: "0.1.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    close: async () => {
      await Promise.all([clientTransport.close(), serverTransport.close()]);
    },
  };
}

describe("smithly mcp server", () => {
  it("lists projects and fetches one project from global scope", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const server = createSmithlyMcpServer(context, {
      attachScope: "global",
      dataDirectory,
    });
    const { client, close } = await connectClient(server);

    const listResult = await client.callTool({
      name: "list_projects",
    });
    const projectResult = await client.callTool({
      arguments: {
        projectId: fixture.project.id,
      },
      name: "get_project_by_id",
    });

    expect(listResult.structuredContent).toMatchObject({
      projects: [
        expect.objectContaining({
          id: fixture.project.id,
          name: fixture.project.name,
          repoPath: fixture.project.repoPath,
          status: fixture.project.status,
        }),
      ],
    });
    expect(projectResult.structuredContent).toMatchObject({
      project: {
        id: fixture.project.id,
        name: fixture.project.name,
        repoPath: fixture.project.repoPath,
        status: fixture.project.status,
      },
    });

    await close();
    context.db.close();
  });

  it("creates draft backlog items from the project planning thread", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const server = createSmithlyMcpServer(context, {
      attachScope: "project",
      dataDirectory,
      projectId: fixture.project.id,
      threadId: fixture.projectChatThread.id,
    });
    const { client, close } = await connectClient(server);

    const result = await client.callTool({
      arguments: {
        scopeSummary: "Create backlog drafts directly from project planning.",
        title: "Create backlog draft through MCP",
      },
      name: "create_draft_backlog_item",
    });

    expect(result.structuredContent).toMatchObject({
      status: "draft",
      title: "Create backlog draft through MCP",
    });

    await close();
    context.db.close();
  });

  it("revises the focused backlog item and exposes project resources", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const server = createSmithlyMcpServer(context, {
      attachScope: "backlog_item",
      backlogItemId: fixture.backlogItem.id,
      dataDirectory,
      projectId: fixture.project.id,
      threadId: fixture.taskChatThread.id,
    });
    const { client, close } = await connectClient(server);

    const resource = await client.readResource({
      uri: "smithly://project/current",
    });
    const reviseResult = await client.callTool({
      arguments: {
        acceptanceCriteria: [
          "Claude can revise the task scope through MCP",
          "Acceptance criteria are persisted in SQLite",
        ],
        noteText: "Track the first revision path through the task planning thread.",
        priority: 95,
        reviewMode: "ai",
        riskLevel: "high",
        scopeSummary: "Revise the selected backlog item through Smithly MCP.",
        status: "approved",
      },
      name: "revise_backlog_item",
    });

    const firstContent = resource.contents[0];

    expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
      '"name": "Smithly"',
    );
    expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
      '"riskLevel": "medium"',
    );
    expect(reviseResult.structuredContent).toMatchObject({
      acceptanceCriteriaCount: 2,
      backlogItemId: fixture.backlogItem.id,
      priority: 95,
      reviewMode: "ai",
      riskLevel: "high",
      status: "approved",
      title: "Bootstrap the desktop shell",
    });

    await close();
    context.db.close();
  });

  it("lists backlog items and claims a backlog item into a task run", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const server = createSmithlyMcpServer(context, {
      attachScope: "backlog_item",
      backlogItemId: fixture.backlogItem.id,
      dataDirectory,
      projectId: fixture.project.id,
      threadId: fixture.taskChatThread.id,
    });
    const { client, close } = await connectClient(server);

    const backlogResult = await client.callTool({
      arguments: {
        statuses: ["approved"],
      },
      name: "list_backlog_items",
    });
    const claimResult = await client.callTool({
      arguments: {
        assignedWorker: "codex",
        backlogItemId: fixture.backlogItem.id,
        status: "queued",
        summaryText: "Claim the next approved task for execution.",
      },
      name: "claim_backlog_item",
    });

    expect(backlogResult.structuredContent).toMatchObject({
      backlogItems: [
        expect.objectContaining({
          id: fixture.backlogItem.id,
          status: "approved",
          title: fixture.backlogItem.title,
        }),
      ],
      projectId: fixture.project.id,
    });
    expect(claimResult.structuredContent).toMatchObject({
      assignedWorker: "codex",
      backlogItemId: fixture.backlogItem.id,
      status: "queued",
      taskRunId: expect.any(String),
    });
    expect(listBacklogItemsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.backlogItem.id,
          status: "in_progress",
        }),
      ]),
    );
    expect(listTaskRunsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignedWorker: "codex",
          backlogItemId: fixture.backlogItem.id,
          status: "queued",
          summaryText: "Claim the next approved task for execution.",
        }),
      ]),
    );

    await close();
    context.db.close();
  });

  it("starts a codex coding task from the focused backlog item", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Create a fresh Codex task from MCP.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Fresh MCP Codex task",
    });
    const server = createSmithlyMcpServer(context, {
      attachScope: "backlog_item",
      backlogItemId: createdBacklogItem.id,
      dataDirectory,
      projectId: fixture.project.id,
      threadId: fixture.taskChatThread.id,
    });
    const { client, close } = await connectClient(server);

    const result = await client.callTool({
      arguments: {
        summaryText: "Start Codex implementation for the selected backlog item.",
      },
      name: "start_coding_task",
    });
    const taskStatusResult = await client.callTool({
      arguments: {
        assignedWorker: "codex",
      },
      name: "list_task_runs",
    });

    expect(result.structuredContent).toMatchObject({
      assignedWorker: "codex",
      backlogItemId: createdBacklogItem.id,
      status: "queued",
      taskRunId: expect.any(String),
    });
    expect(listTaskRunsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignedWorker: "codex",
          backlogItemId: createdBacklogItem.id,
          status: "queued",
          summaryText: "Start Codex implementation for the selected backlog item.",
        }),
      ]),
    );
    expect(taskStatusResult.structuredContent).toMatchObject({
      taskRuns: expect.arrayContaining([
        expect.objectContaining({
          assignedWorker: "codex",
          backlogItemId: createdBacklogItem.id,
          status: "queued",
          summaryText: "Start Codex implementation for the selected backlog item.",
          taskRunId: expect.any(String),
          workerSessionId: null,
          workerSessionStatus: null,
        }),
      ]),
    });

    await close();
    context.db.close();
  });

  it("persists approvals, blockers, memory notes, and verification or review requests", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const server = createSmithlyMcpServer(context, {
      attachScope: "backlog_item",
      backlogItemId: fixture.backlogItem.id,
      dataDirectory,
      projectId: fixture.project.id,
      threadId: fixture.taskChatThread.id,
    });
    const { client, close } = await connectClient(server);

    const approvalResult = await client.callTool({
      arguments: {
        backlogItemId: fixture.backlogItem.id,
        detail: "Approve the next scope change before implementation continues.",
        title: "Approve scope change",
      },
      name: "request_approval",
    });
    const blockerResult = await client.callTool({
      arguments: {
        blockerType: "system",
        detail: "The background watcher needs a clean restart.",
        title: "Restart watcher",
      },
      name: "raise_blocker",
    });
    const questionResult = await client.callTool({
      arguments: {
        contextText: "The task is paused until the operator answers.",
        question: "Should this backlog item stay AI-reviewed or switch to human review?",
        title: "Review mode decision",
      },
      name: "ask_human_question",
    });
    const resolveResult = await client.callTool({
      arguments: {
        blockerId: (blockerResult.structuredContent as { blockerId: string }).blockerId,
        resolutionNote: "Watcher restarted cleanly.",
      },
      name: "resolve_blocker",
    });
    const memoryResult = await client.callTool({
      arguments: {
        backlogItemId: fixture.backlogItem.id,
        bodyText: "The operator wants tighter human review on risky scope changes.",
        noteType: "decision",
        title: "Review preference",
      },
      name: "write_memory_note",
    });
    const memoryListResult = await client.callTool({
      arguments: {
        noteTypes: ["decision"],
      },
      name: "list_memory_notes",
    });
    const verificationResult = await client.callTool({
      arguments: {
        commandText: "npm run check",
        summaryText: "Run the standard project verification pipeline.",
        taskRunId: fixture.taskRun.id,
      },
      name: "request_verification_run",
    });
    const reviewResult = await client.callTool({
      arguments: {
        reviewerKind: "human",
        summaryText: "Operator review is required for this slice.",
        taskRunId: fixture.taskRun.id,
      },
      name: "request_review_run",
    });
    const approvalsListResult = await client.callTool({
      name: "list_pending_approvals",
    });
    const blockersListResult = await client.callTool({
      name: "list_open_blockers",
    });

    expect(approvalResult.structuredContent).toMatchObject({
      approvalId: expect.any(String),
      status: "pending",
      title: "Approve scope change",
    });
    expect(blockerResult.structuredContent).toMatchObject({
      blockerId: expect.any(String),
      status: "open",
      title: "Restart watcher",
    });
    expect(questionResult.structuredContent).toMatchObject({
      blockerId: expect.any(String),
      status: "open",
      title: "Review mode decision",
    });
    expect(resolveResult.structuredContent).toMatchObject({
      blockerId: (blockerResult.structuredContent as { blockerId: string }).blockerId,
      resolutionNote: "Watcher restarted cleanly.",
      status: "resolved",
    });
    expect(memoryResult.structuredContent).toMatchObject({
      noteId: expect.any(String),
      noteType: "decision",
      title: "Review preference",
    });
    expect(memoryListResult.structuredContent).toMatchObject({
      memoryNotes: expect.arrayContaining([
        expect.objectContaining({
          noteType: "decision",
          title: "Review preference",
        }),
      ]),
      projectId: fixture.project.id,
    });
    expect(verificationResult.structuredContent).toMatchObject({
      status: "queued",
      taskRunId: fixture.taskRun.id,
      verificationRunId: expect.any(String),
    });
    expect(reviewResult.structuredContent).toMatchObject({
      reviewRunId: expect.any(String),
      reviewerKind: "human",
      status: "queued",
      taskRunId: fixture.taskRun.id,
    });
    expect(approvalsListResult.structuredContent).toMatchObject({
      approvals: expect.arrayContaining([
        expect.objectContaining({
          title: "Approve shell bootstrap work",
        }),
        expect.objectContaining({
          title: "Approve scope change",
        }),
      ]),
    });
    expect(blockersListResult.structuredContent).toMatchObject({
      blockers: expect.arrayContaining([
        expect.objectContaining({
          title: "Need terminal integration decision",
        }),
      ]),
    });
    expect(listApprovalsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "Approve the next scope change before implementation continues.",
          status: "pending",
          title: "Approve scope change",
        }),
      ]),
    );
    expect(listBlockersForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resolutionNote: "Watcher restarted cleanly.",
          status: "resolved",
          title: "Restart watcher",
        }),
        expect.objectContaining({
          blockerType: "human",
          status: "open",
          title: "Review mode decision",
        }),
      ]),
    );
    expect(listMemoryNotesForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          noteType: "decision",
          sourceThreadId: fixture.taskChatThread.id,
          title: "Review preference",
        }),
      ]),
    );
    expect(listVerificationRunsForTask(context, fixture.taskRun.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandText: "npm run check",
          status: "queued",
        }),
      ]),
    );
    expect(listReviewRunsForTask(context, fixture.taskRun.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewerKind: "human",
          status: "queued",
        }),
      ]),
    );

    await close();
    context.db.close();
  });
});

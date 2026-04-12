import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  listBacklogDependencyLinksForProject,
  listBacklogItemsForProject,
  listBlockersForProject,
  listMemoryNotesForProject,
  listProjects,
  listReviewRunsForTask,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  reviseBacklogItemFromPlanning,
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

  it("inspects a bootstrap target folder without persisting a project", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-bootstrap-"));
    const targetParentDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-bootstrap-target-"));

    temporaryDirectories.push(dataDirectory, targetParentDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const server = createSmithlyMcpServer(context, {
      attachScope: "global",
      dataDirectory,
    });
    const { client, close } = await connectClient(server);
    const targetFolderPath = join(targetParentDirectory, "new-project");

    const result = await client.callTool({
      arguments: {
        intent: "create",
        targetFolderPath,
      },
      name: "inspect_bootstrap_target_folder",
    });

    expect(result.structuredContent).toMatchObject({
      canAdoptProject: false,
      canCreateInParent: true,
      exists: false,
      intent: "create",
      isDirectory: false,
      looksLikeGitWorkingTree: false,
      normalizedTargetFolderPath: targetFolderPath,
      parentDirectoryPath: targetParentDirectory,
      parentExists: true,
    });
    expect(listProjects(context)).toEqual([]);

    await close();
    context.db.close();
  });

  it("registers a bootstrap-created repo only after operator confirmation", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-bootstrap-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-bootstrap-repo-"));

    temporaryDirectories.push(dataDirectory, repoDirectory);
    mkdirSync(join(repoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const server = createSmithlyMcpServer(context, {
      attachScope: "global",
      dataDirectory,
    });
    const { client, close } = await connectClient(server);

    const unconfirmedResult = await client.callTool({
      arguments: {
        name: "Bootstrap Draft",
        operatorConfirmed: false,
        repoPath: repoDirectory,
      },
      name: "create_project_from_bootstrap",
    });

    expect(unconfirmedResult.isError).toBe(true);
    expect(unconfirmedResult.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("requires explicit operator confirmation"),
        type: "text",
      }),
    ]);

    const result = await client.callTool({
      arguments: {
        defaultBranch: "main",
        name: "Bootstrap Draft",
        operatorConfirmed: true,
        repoPath: repoDirectory,
        verificationCommands: ["npm run check"],
      },
      name: "create_project_from_bootstrap",
    });

    expect(result.structuredContent).toMatchObject({
      project: {
        id: expect.any(String),
        name: "Bootstrap Draft",
        repoPath: repoDirectory,
        status: "paused",
      },
    });
    expect(listProjects(context)).toEqual([
      expect.objectContaining({
        defaultBranch: "main",
        name: "Bootstrap Draft",
        repoPath: repoDirectory,
        status: "paused",
      }),
    ]);

    await close();
    context.db.close();
  });

  it("adopts an existing repo from bootstrap after operator confirmation", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-adopt-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-adopt-repo-"));

    temporaryDirectories.push(dataDirectory, repoDirectory);
    mkdirSync(join(repoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const server = createSmithlyMcpServer(context, {
      attachScope: "global",
      dataDirectory,
    });
    const { client, close } = await connectClient(server);

    const inspectResult = await client.callTool({
      arguments: {
        intent: "adopt",
        targetFolderPath: repoDirectory,
      },
      name: "inspect_bootstrap_target_folder",
    });
    const result = await client.callTool({
      arguments: {
        name: "Adopted Repo",
        operatorConfirmed: true,
        repoPath: repoDirectory,
      },
      name: "adopt_project_from_bootstrap",
    });

    expect(inspectResult.structuredContent).toMatchObject({
      canAdoptProject: true,
      exists: true,
      isDirectory: true,
      looksLikeGitWorkingTree: true,
      normalizedTargetFolderPath: repoDirectory,
    });
    expect(result.structuredContent).toMatchObject({
      project: {
        id: expect.any(String),
        name: "Adopted Repo",
        repoPath: repoDirectory,
        status: "paused",
      },
    });

    await close();
    context.db.close();
  });

  it("stores bootstrap planning state, drafts initial backlog, and finalizes the bootstrap project", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-bootstrap-flow-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-bootstrap-flow-repo-"));

    temporaryDirectories.push(dataDirectory, repoDirectory);
    mkdirSync(join(repoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const server = createSmithlyMcpServer(context, {
      attachScope: "global",
      dataDirectory,
    });
    const { client, close } = await connectClient(server);
    const createResult = await client.callTool({
      arguments: {
        name: "Bootstrap Flow",
        operatorConfirmed: true,
        repoPath: repoDirectory,
      },
      name: "create_project_from_bootstrap",
    });
    const projectId = (
      createResult.structuredContent as {
        project: {
          id: string;
        };
      }
    ).project.id;

    const planResult = await client.callTool({
      arguments: {
        planText:
          "Ship a narrow MVP, draft the first backlog, and approve the earliest execution slices before dashboard handoff.",
        projectId,
      },
      name: "save_bootstrap_mvp_plan",
    });
    const draftResult = await client.callTool({
      arguments: {
        acceptanceCriteria: [
          "Bootstrap can persist the MVP plan",
          "Bootstrap can draft the first backlog items before dashboard handoff",
        ],
        priority: 85,
        projectId,
        reviewMode: "human",
        riskLevel: "medium",
        scopeSummary: "Draft the first bootstrap backlog item from the MVP plan.",
        title: "Bootstrap first backlog item",
      },
      name: "draft_bootstrap_backlog_item",
    });
    const approveResult = await client.callTool({
      arguments: {
        backlogItemId: (
          draftResult.structuredContent as {
            backlogItem: {
              id: string;
            };
          }
        ).backlogItem.id,
        detail: "Reviewed and approved with the operator during bootstrap.",
      },
      name: "approve_bootstrap_backlog_item",
    });
    const stateResult = await client.callTool({
      arguments: {
        projectId,
      },
      name: "get_bootstrap_project_state",
    });
    const finalizeResult = await client.callTool({
      arguments: {
        projectId,
      },
      name: "finalize_bootstrap_project",
    });

    expect(planResult.structuredContent).toMatchObject({
      noteId: `memory-bootstrap-mvp-plan-${projectId}`,
      projectId,
      title: "Bootstrap MVP plan",
    });
    expect(draftResult.structuredContent).toMatchObject({
      backlogItem: {
        id: expect.any(String),
        priority: 85,
        readiness: "not_ready",
        reviewMode: "human",
        riskLevel: "medium",
        status: "draft",
        title: "Bootstrap first backlog item",
      },
    });
    expect(approveResult.structuredContent).toMatchObject({
      approvalId: expect.any(String),
      backlogItemId: expect.any(String),
      status: "approved",
    });
    expect(stateResult.structuredContent).toMatchObject({
      approvedBacklogCount: 1,
      bootstrapState: "planning",
      draftBacklogCount: 0,
      hasMvpPlan: true,
      mvpPlan: expect.stringContaining("narrow MVP"),
      readyBacklogCount: 1,
      project: {
        id: projectId,
        name: "Bootstrap Flow",
      },
    });
    expect(finalizeResult.structuredContent).toMatchObject({
      bootstrapState: "ready_for_dashboard",
      project: {
        id: projectId,
        name: "Bootstrap Flow",
      },
    });
    expect(listBacklogItemsForProject(context, projectId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          readiness: "ready",
          status: "approved",
          title: "Bootstrap first backlog item",
        }),
      ]),
    );
    expect(listApprovalsForProject(context, projectId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: "Reviewed and approved with the operator during bootstrap.",
          status: "approved",
        }),
      ]),
    );

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
        readiness: "ready",
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
      readiness: "ready",
      reviewMode: "ai",
      riskLevel: "high",
      status: "approved",
      title: "Bootstrap the desktop shell",
    });

    await close();
    context.db.close();
  });

  it("reprioritizes and reorders pending backlog items during project planning", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const firstPendingBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "First pending item.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "First pending item",
    });
    const secondPendingBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Second pending item.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Second pending item",
    });
    const server = createSmithlyMcpServer(context, {
      attachScope: "project",
      dataDirectory,
      projectId: fixture.project.id,
      threadId: fixture.projectChatThread.id,
    });
    const { client, close } = await connectClient(server);

    const reprioritizeResult = await client.callTool({
      arguments: {
        backlogItemId: firstPendingBacklogItem.id,
        noteText: "Move this draft higher in the queue.",
        priority: 88,
      },
      name: "reprioritize_backlog_item",
    });
    const reorderResult = await client.callTool({
      arguments: {
        backlogItemIds: [secondPendingBacklogItem.id, firstPendingBacklogItem.id],
        noteText: "Put the second item first.",
      },
      name: "reorder_pending_backlog_items",
    });

    expect(reprioritizeResult.structuredContent).toMatchObject({
      backlogItem: {
        id: firstPendingBacklogItem.id,
        priority: 88,
        readiness: "not_ready",
        status: "draft",
        title: "First pending item",
      },
    });
    expect(reorderResult.structuredContent).toMatchObject({
      backlogItems: [
        expect.objectContaining({
          id: secondPendingBacklogItem.id,
          status: "draft",
        }),
        expect.objectContaining({
          id: firstPendingBacklogItem.id,
          status: "draft",
        }),
      ],
      projectId: fixture.project.id,
    });
    expect(
      listBacklogItemsForProject(context, fixture.project.id)
        .filter((backlogItem) => backlogItem.id !== fixture.backlogItem.id)
        .map((backlogItem) => backlogItem.id),
    ).toEqual([secondPendingBacklogItem.id, firstPendingBacklogItem.id]);

    await close();
    context.db.close();
  });

  it("adds, lists, and removes explicit backlog dependency links", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const blockingBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Blocking item.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Blocking item",
    });
    const blockedBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Blocked item.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Blocked item",
    });
    const server = createSmithlyMcpServer(context, {
      attachScope: "project",
      dataDirectory,
      projectId: fixture.project.id,
      threadId: fixture.projectChatThread.id,
    });
    const { client, close } = await connectClient(server);

    const addResult = await client.callTool({
      arguments: {
        blockedBacklogItemId: blockedBacklogItem.id,
        blockingBacklogItemId: blockingBacklogItem.id,
        noteText: "Link the blocked item to the blocking item.",
      },
      name: "add_backlog_dependency",
    });
    const listResult = await client.callTool({
      arguments: {
        backlogItemId: blockedBacklogItem.id,
      },
      name: "list_backlog_dependencies",
    });
    const removeResult = await client.callTool({
      arguments: {
        blockedBacklogItemId: blockedBacklogItem.id,
        blockingBacklogItemId: blockingBacklogItem.id,
      },
      name: "remove_backlog_dependency",
    });

    expect(addResult.structuredContent).toMatchObject({
      dependency: {
        blockedBacklogItemId: blockedBacklogItem.id,
        blockingBacklogItemId: blockingBacklogItem.id,
        projectId: fixture.project.id,
      },
    });
    expect(listResult.structuredContent).toMatchObject({
      dependencies: [
        expect.objectContaining({
          blockedBacklogItemId: blockedBacklogItem.id,
          blockingBacklogItemId: blockingBacklogItem.id,
        }),
      ],
    });
    expect(removeResult.structuredContent).toMatchObject({
      removed: true,
    });
    expect(listBacklogDependencyLinksForProject(context, fixture.project.id)).toEqual([]);

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
          readiness: "ready",
          status: "approved",
          title: fixture.backlogItem.title,
        }),
      ],
      projectId: fixture.project.id,
    });
    expect(claimResult.structuredContent).toMatchObject({
      assignedWorker: "codex",
      backlogItemId: fixture.backlogItem.id,
      status: "running",
      taskRunId: fixture.taskRun.id,
    });
    expect(listBacklogItemsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.backlogItem.id,
          status: "approved",
        }),
      ]),
    );
    expect(listTaskRunsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignedWorker: "codex",
          backlogItemId: fixture.backlogItem.id,
          status: "running",
          summaryText: "Scaffold the first desktop shell with one project dashboard card.",
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
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["The task is approved and ready before Codex starts."],
      backlogItemId: createdBacklogItem.id,
      readiness: "ready",
      scopeSummary: "Create a fresh Codex task from MCP.",
      status: "approved",
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

  it("rejects task claims until work is approved and ready", async () => {
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
      scopeSummary: "Keep this task out of execution until planning is complete.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Blocked by readiness",
    });
    const server = createSmithlyMcpServer(context, {
      attachScope: "backlog_item",
      backlogItemId: createdBacklogItem.id,
      dataDirectory,
      projectId: fixture.project.id,
      threadId: fixture.taskChatThread.id,
    });
    const { client, close } = await connectClient(server);

    const claimResult = await client.callTool({
      arguments: {
        assignedWorker: "codex",
        backlogItemId: createdBacklogItem.id,
      },
      name: "claim_backlog_item",
    });

    expect(claimResult.isError).toBe(true);
    expect(claimResult.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("cannot start execution"),
        }),
      ]),
    );

    await close();
    context.db.close();
  });

  it("rejects reordering the active backlog item", async () => {
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
        backlogItemIds: [fixture.backlogItem.id],
      },
      name: "reorder_pending_backlog_items",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("cannot be reordered"),
        }),
      ]),
    );

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

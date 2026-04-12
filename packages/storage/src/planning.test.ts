import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";

import { createContext, closeContext } from "./context.ts";
import {
  listApprovalsForProject,
  listBacklogDependencyLinksForProject,
  getBacklogItemById,
  listBacklogItemsForProject,
  listChatMessagesForThread,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  listTaskRunsForProject,
} from "./data.ts";
import {
  addBacklogDependency,
  approveBootstrapBacklogItem,
  createBootstrapBacklogItem,
  createDraftBacklogItemFromPlanning,
  ensureProjectPlanningThread,
  finalizeBootstrapProject,
  getBootstrapMvpPlan,
  removeBacklogDependency,
  reorderPendingBacklogItems,
  reprioritizeBacklogItemForPlanning,
  reviseBacklogItemFromPlanning,
  startCodingTask,
  upsertBootstrapMvpPlan,
} from "./planning.ts";
import { seedInitialState } from "./seed.ts";
import { parseProjectMetadata, registerLocalProject } from "./projects.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("planning mutations", () => {
  it("allows a second storage context to write planning state while the first stays open", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const primaryContext = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(primaryContext);
    const secondaryContext = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    const createdBacklogItem = createDraftBacklogItemFromPlanning(secondaryContext, {
      projectId: fixture.project.id,
      scopeSummary: "Write through a second SQLite connection without locking the app shell.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Multi-context planning write",
    });

    expect(
      listBacklogItemsForProject(primaryContext, fixture.project.id).some((backlogItem) => {
        return backlogItem.id === createdBacklogItem.id;
      }),
    ).toBe(true);

    closeContext(secondaryContext);
    closeContext(primaryContext);
  });

  it("creates a draft backlog item and task planning thread from a project planning thread", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);

    const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Plan the first Smithly MCP tool surface.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Add Smithly MCP draft backlog creation",
    });

    const backlogItems = listBacklogItemsForProject(context, fixture.project.id);
    const taskPlanningThread = listChatThreadsForProject(context, fixture.project.id).find(
      (thread) => {
        return thread.backlogItemId === createdBacklogItem.id;
      },
    );
    const projectPlanningMessages = listChatMessagesForThread(
      context,
      fixture.projectChatThread.id,
    );

    expect(backlogItems).toHaveLength(2);
    expect(createdBacklogItem.readiness).toBe("not_ready");
    expect(createdBacklogItem.status).toBe("draft");
    expect(createdBacklogItem.title).toBe("Add Smithly MCP draft backlog creation");
    expect(taskPlanningThread?.kind).toBe("task_planning");
    expect(projectPlanningMessages.at(-1)?.bodyText).toContain("Created draft backlog item");

    closeContext(context);
  });

  it("revises a backlog item and records the revision against the task planning thread", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);

    const revisedBacklogItem = reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: [
        "Project planning can create draft backlog items through MCP",
        "Task planning can revise acceptance criteria through MCP",
      ],
      backlogItemId: fixture.backlogItem.id,
      noteText: "Keep the first write path scoped to backlog metadata only.",
      priority: 95,
      readiness: "ready",
      reviewMode: "ai",
      riskLevel: "high",
      scopeSummary: "Use MCP-backed planning actions for backlog creation and revision.",
      sourceThreadId: fixture.taskChatThread.id,
      status: "approved",
    });
    const storedBacklogItem = getBacklogItemById(context, fixture.backlogItem.id);
    const taskPlanningMessages = listChatMessagesForThread(context, fixture.taskChatThread.id);

    expect(revisedBacklogItem.scopeSummary).toBe(
      "Use MCP-backed planning actions for backlog creation and revision.",
    );
    expect(revisedBacklogItem.priority).toBe(95);
    expect(revisedBacklogItem.readiness).toBe("ready");
    expect(revisedBacklogItem.reviewMode).toBe("ai");
    expect(revisedBacklogItem.riskLevel).toBe("high");
    expect(revisedBacklogItem.status).toBe("approved");
    expect(storedBacklogItem?.acceptanceCriteriaJson).toBe(
      JSON.stringify([
        "Project planning can create draft backlog items through MCP",
        "Task planning can revise acceptance criteria through MCP",
      ]),
    );
    expect(
      taskPlanningMessages.some((message) => message.bodyText.includes("Updated backlog item")),
    ).toBe(true);
    expect(
      taskPlanningMessages.some((message) => {
        return message.bodyText === "Keep the first write path scoped to backlog metadata only.";
      }),
    ).toBe(true);

    closeContext(context);
  });

  it("starts one active coding task per backlog item and worker", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Use a fresh backlog item for Codex task startup.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Fresh Codex task",
    });
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["The backlog item is approved and ready for Codex execution."],
      backlogItemId: createdBacklogItem.id,
      readiness: "ready",
      scopeSummary: "Use a fresh backlog item for Codex task startup.",
      status: "approved",
    });

    const firstTaskRun = startCodingTask(context, {
      backlogItemId: createdBacklogItem.id,
      summaryText: "Start Codex implementation for the selected backlog item.",
    });
    const secondTaskRun = startCodingTask(context, {
      backlogItemId: createdBacklogItem.id,
    });

    expect(firstTaskRun.id).toBe(secondTaskRun.id);
    expect(firstTaskRun.assignedWorker).toBe("codex");
    expect(firstTaskRun.status).toBe("queued");
    expect(firstTaskRun.summaryText).toBe(
      "Start Codex implementation for the selected backlog item.",
    );
    expect(getBacklogItemById(context, createdBacklogItem.id)?.status).toBe("in_progress");
    expect(
      listTaskRunsForProject(context, fixture.project.id).filter((taskRun) => {
        return (
          taskRun.backlogItemId === createdBacklogItem.id && taskRun.assignedWorker === "codex"
        );
      }),
    ).toHaveLength(1);

    closeContext(context);
  });

  it("rejects execution until a backlog item is approved and ready", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const createdBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Hold execution until planning makes this task ready.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Not ready yet",
    });

    expect(() =>
      startCodingTask(context, {
        backlogItemId: createdBacklogItem.id,
      }),
    ).toThrow("cannot start execution");

    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["Planning has clarified the task."],
      backlogItemId: createdBacklogItem.id,
      readiness: "ready",
      scopeSummary: "Hold execution until planning makes this task ready.",
      status: "approved",
    });

    expect(() =>
      startCodingTask(context, {
        backlogItemId: createdBacklogItem.id,
      }),
    ).not.toThrow();

    closeContext(context);
  });

  it("reprioritizes only pending backlog items during planning", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const pendingBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "This backlog item stays pending.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Pending task",
    });

    const reprioritizedBacklogItem = reprioritizeBacklogItemForPlanning(context, {
      backlogItemId: pendingBacklogItem.id,
      noteText: "Move this closer to the top of the pending queue.",
      priority: 77,
      sourceThreadId: fixture.projectChatThread.id,
    });

    expect(reprioritizedBacklogItem.priority).toBe(77);
    expect(getBacklogItemById(context, pendingBacklogItem.id)?.priority).toBe(77);
    expect(
      listChatMessagesForThread(context, fixture.projectChatThread.id).some((message) => {
        return message.bodyText.includes('Reprioritized backlog item "Pending task"');
      }),
    ).toBe(true);
    expect(() =>
      reprioritizeBacklogItemForPlanning(context, {
        backlogItemId: fixture.backlogItem.id,
        priority: 99,
      }),
    ).toThrow("cannot be reprioritized");

    closeContext(context);
  });

  it("reorders only pending backlog items and leaves active work untouched", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const firstPendingBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "First pending task.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "First pending task",
    });
    const secondPendingBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Second pending task.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Second pending task",
    });
    const thirdPendingBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Third pending task.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Third pending task",
    });

    const reorderedBacklogItems = reorderPendingBacklogItems(context, {
      backlogItemIds: [thirdPendingBacklogItem.id, firstPendingBacklogItem.id],
      noteText: "Make the third item next, then keep the first one close behind.",
      projectId: fixture.project.id,
      sourceThreadId: fixture.projectChatThread.id,
    });
    const pendingBacklogItemIdsInOrder = listBacklogItemsForProject(context, fixture.project.id)
      .filter((backlogItem) => {
        return backlogItem.id !== fixture.backlogItem.id;
      })
      .map((backlogItem) => backlogItem.id);

    expect(reorderedBacklogItems.map((backlogItem) => backlogItem.id).slice(0, 3)).toEqual([
      thirdPendingBacklogItem.id,
      firstPendingBacklogItem.id,
      secondPendingBacklogItem.id,
    ]);
    expect(pendingBacklogItemIdsInOrder).toEqual([
      thirdPendingBacklogItem.id,
      firstPendingBacklogItem.id,
      secondPendingBacklogItem.id,
    ]);
    expect(getBacklogItemById(context, fixture.backlogItem.id)?.priority).toBe(fixture.backlogItem.priority);
    expect(() =>
      reorderPendingBacklogItems(context, {
        backlogItemIds: [fixture.backlogItem.id],
        projectId: fixture.project.id,
      }),
    ).toThrow("cannot be reordered");

    closeContext(context);
  });

  it("links dependencies and blocks execution until the dependency is done", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const blockingBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Finish this task first.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Blocking task",
    });
    const blockedBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "This task depends on the first one.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Blocked task",
    });

    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["This task must complete before the dependent task can start."],
      backlogItemId: blockingBacklogItem.id,
      readiness: "ready",
      scopeSummary: "Finish this task first.",
      status: "approved",
    });
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["This task waits for the blocking task."],
      backlogItemId: blockedBacklogItem.id,
      readiness: "ready",
      scopeSummary: "This task depends on the first one.",
      status: "approved",
    });

    const dependencyRecord = addBacklogDependency(context, {
      blockedBacklogItemId: blockedBacklogItem.id,
      blockingBacklogItemId: blockingBacklogItem.id,
      noteText: "Do not start the blocked task until the first one is done.",
      sourceThreadId: fixture.projectChatThread.id,
    });

    expect(listBacklogDependencyLinksForProject(context, fixture.project.id)).toEqual([
      dependencyRecord,
    ]);
    expect(() =>
      startCodingTask(context, {
        backlogItemId: blockedBacklogItem.id,
      }),
    ).toThrow("dependencies are not cleared");

    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["This task must complete before the dependent task can start."],
      backlogItemId: blockingBacklogItem.id,
      readiness: "ready",
      scopeSummary: "Finish this task first.",
      status: "done",
    });

    expect(() =>
      startCodingTask(context, {
        backlogItemId: blockedBacklogItem.id,
      }),
    ).not.toThrow();
    expect(
      removeBacklogDependency(context, {
        blockedBacklogItemId: blockedBacklogItem.id,
        blockingBacklogItemId: blockingBacklogItem.id,
        sourceThreadId: fixture.projectChatThread.id,
      }),
    ).toBe(true);
    expect(listBacklogDependencyLinksForProject(context, fixture.project.id)).toEqual([]);

    closeContext(context);
  });

  it("stores a bootstrap MVP plan on the project planning thread", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const planningThread = ensureProjectPlanningThread(context, fixture.project.id);
    const planNote = upsertBootstrapMvpPlan(context, {
      bodyText:
        "Ship a narrow local-first operator app that can plan, approve, and run one coding task at a time.",
      projectId: fixture.project.id,
    });
    const storedPlan = getBootstrapMvpPlan(context, fixture.project.id);
    const planningMessages = listChatMessagesForThread(context, planningThread.id);

    expect(planNote.id).toBe(`memory-bootstrap-mvp-plan-${fixture.project.id}`);
    expect(storedPlan?.bodyText).toContain("local-first operator app");
    expect(
      planningMessages.some((message) => {
        return message.bodyText === "Updated the bootstrap MVP plan for this project.";
      }),
    ).toBe(true);
    expect(listMemoryNotesForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `memory-bootstrap-mvp-plan-${fixture.project.id}`,
          title: "Bootstrap MVP plan",
        }),
      ]),
    );

    closeContext(context);
  });

  it("drafts, approves, and finalizes bootstrap backlog state", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));
    const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-repo-"));

    temporaryDirectories.push(dataDirectory, repoDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const project = registerFixtureProject(context, repoDirectory);

    upsertBootstrapMvpPlan(context, {
      bodyText:
        "Draft the MVP, review the first few slices, and only then hand the project off to the dashboard.",
      projectId: project.id,
    });

    const backlogItem = createBootstrapBacklogItem(context, {
      acceptanceCriteria: [
        "Bootstrap can write an MVP plan",
        "Claude can draft initial backlog items before dashboard handoff",
      ],
      priority: 80,
      projectId: project.id,
      reviewMode: "human",
      riskLevel: "medium",
      scopeSummary: "Create the first bootstrap backlog item from the MVP plan.",
      title: "Draft bootstrap backlog",
    });
    const approvalResult = approveBootstrapBacklogItem(context, {
      backlogItemId: backlogItem.id,
      detail: "Reviewed with the operator during bootstrap planning.",
    });
    const finalizedProject = finalizeBootstrapProject(context, {
      projectId: project.id,
    });

    expect(getBacklogItemById(context, backlogItem.id)?.status).toBe("approved");
    expect(getBacklogItemById(context, backlogItem.id)?.readiness).toBe("ready");
    expect(approvalResult.approval.status).toBe("approved");
    expect(listApprovalsForProject(context, project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backlogItemId: backlogItem.id,
          status: "approved",
          title: `Approve bootstrap backlog item: ${backlogItem.title}`,
        }),
      ]),
    );
    expect(parseProjectMetadata(finalizedProject).metadata).toMatchObject({
      bootstrapApprovedBacklogCount: "1",
      bootstrapState: "ready_for_dashboard",
    });

    closeContext(context);
  });
});

function registerFixtureProject(context: ReturnType<typeof createContext>, repoDirectory: string) {
  mkdirSync(join(repoDirectory, ".git"));
  return registerLocalProject(context, {
    name: "Bootstrap Fixture",
    repoPath: repoDirectory,
  });
}

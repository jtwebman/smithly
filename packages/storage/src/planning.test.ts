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
  explainWhyBacklogItemIsNext,
  finalizeBootstrapProject,
  markBacklogItemStaleFromPlanning,
  mergeDuplicateBacklogItemsFromPlanning,
  getBootstrapMvpPlan,
  removePendingBacklogItemFromPlanning,
  removeBacklogDependency,
  reorderPendingBacklogItems,
  reprioritizeBacklogItemForPlanning,
  reviseBacklogItemFromPlanning,
  splitBacklogItemFromPlanning,
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

  it("creates a draft backlog item from a task planning thread", () => {
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
      scopeSummary: "Split follow-up work from the current task planning chat.",
      sourceThreadId: fixture.taskChatThread.id,
      title: "Task planning split draft",
    });

    expect(createdBacklogItem.status).toBe("draft");
    expect(listBacklogItemsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: createdBacklogItem.id,
          title: "Task planning split draft",
        }),
      ]),
    );

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
    const editableBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Editable planning item.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Editable planning item",
    });
    const editableTaskPlanningThread = listChatThreadsForProject(context, fixture.project.id).find(
      (thread) => {
        return thread.kind === "task_planning" && thread.backlogItemId === editableBacklogItem.id;
      },
    );

    const revisedBacklogItem = reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: [
        "Project planning can create draft backlog items through MCP",
        "Task planning can revise acceptance criteria through MCP",
      ],
      backlogItemId: editableBacklogItem.id,
      noteText: "Keep the first write path scoped to backlog metadata only.",
      priority: 95,
      readiness: "ready",
      reviewMode: "ai",
      riskLevel: "high",
      scopeSummary: "Use MCP-backed planning actions for backlog creation and revision.",
      sourceThreadId: editableTaskPlanningThread?.id ?? fixture.taskChatThread.id,
      status: "approved",
    });
    const storedBacklogItem = getBacklogItemById(context, editableBacklogItem.id);
    const taskPlanningMessages = listChatMessagesForThread(
      context,
      editableTaskPlanningThread?.id ?? fixture.taskChatThread.id,
    );

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

  it("blocks planning from silently mutating an active backlog item's scope", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);

    expect(() =>
      reviseBacklogItemFromPlanning(context, {
        acceptanceCriteria: [
          "Do not silently mutate the active task scope.",
          "Create a follow-up task instead.",
        ],
        backlogItemId: fixture.backlogItem.id,
        scopeSummary: "Rewrite the active task while Codex is already running.",
        sourceThreadId: fixture.taskChatThread.id,
        status: "approved",
      }),
    ).toThrow("Pause and replan");

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

  it("removes a pending backlog item from task planning without touching active work", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const removableBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Draft that will be removed from planning.",
      sourceThreadId: fixture.taskChatThread.id,
      title: "Remove me from planning",
    });

    const removedBacklogItem = removePendingBacklogItemFromPlanning(context, {
      backlogItemId: removableBacklogItem.id,
      noteText: "This split draft is no longer needed.",
      sourceThreadId: fixture.taskChatThread.id,
    });

    expect(removedBacklogItem.status).toBe("cancelled");
    expect(getBacklogItemById(context, removableBacklogItem.id)?.status).toBe("cancelled");
    expect(() =>
      removePendingBacklogItemFromPlanning(context, {
        backlogItemId: fixture.backlogItem.id,
      }),
    ).toThrow("cannot be removed");

    closeContext(context);
  });

  it("splits an oversized pending backlog item into smaller drafts and rewires dependencies", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const oversizedBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "One backlog item is trying to cover too much work.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Oversized planning item",
    });
    const blockedBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "This work is blocked by the oversized planning item.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Blocked by oversized item",
    });

    addBacklogDependency(context, {
      blockedBacklogItemId: blockedBacklogItem.id,
      blockingBacklogItemId: oversizedBacklogItem.id,
      sourceThreadId: fixture.projectChatThread.id,
    });

    const result = splitBacklogItemFromPlanning(context, {
      backlogItemId: oversizedBacklogItem.id,
      noteText: "Break the oversized task into two narrower slices.",
      sourceThreadId: fixture.projectChatThread.id,
      splitItems: [
        {
          scopeSummary: "First smaller slice from the oversized task.",
          title: "Split slice one",
        },
        {
          scopeSummary: "Second smaller slice from the oversized task.",
          title: "Split slice two",
        },
      ],
    });

    expect(result.originalBacklogItem.status).toBe("cancelled");
    expect(result.splitBacklogItems).toHaveLength(2);
    expect(listBacklogItemsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: result.splitBacklogItems[0]?.id,
          title: "Split slice one",
        }),
        expect.objectContaining({
          id: result.splitBacklogItems[1]?.id,
          title: "Split slice two",
        }),
      ]),
    );
    expect(listBacklogDependencyLinksForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockedBacklogItemId: blockedBacklogItem.id,
          blockingBacklogItemId: result.splitBacklogItems[0]?.id,
        }),
      ]),
    );

    closeContext(context);
  });

  it("merges duplicate pending backlog items into one retained item", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const targetBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Primary backlog item for duplicate merge coverage.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Canonical task",
    });
    const duplicateBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Duplicate scope that should be folded into the canonical task.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Duplicate task",
    });
    const downstreamBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "This task depends on the duplicate task today.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Downstream task",
    });

    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["Canonical acceptance criterion"],
      backlogItemId: targetBacklogItem.id,
      scopeSummary: targetBacklogItem.scopeSummary ?? "",
      status: "draft",
    });
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["Duplicate acceptance criterion"],
      backlogItemId: duplicateBacklogItem.id,
      riskLevel: "high",
      reviewMode: "human",
      scopeSummary: duplicateBacklogItem.scopeSummary ?? "",
      status: "draft",
    });
    addBacklogDependency(context, {
      blockedBacklogItemId: downstreamBacklogItem.id,
      blockingBacklogItemId: duplicateBacklogItem.id,
      sourceThreadId: fixture.projectChatThread.id,
    });

    const result = mergeDuplicateBacklogItemsFromPlanning(context, {
      duplicateBacklogItemIds: [duplicateBacklogItem.id],
      noteText: "Collapse duplicate scope into the canonical task.",
      sourceThreadId: fixture.projectChatThread.id,
      targetBacklogItemId: targetBacklogItem.id,
    });
    const storedMergedBacklogItem = getBacklogItemById(context, targetBacklogItem.id);

    expect(result.cancelledBacklogItems).toEqual([
      expect.objectContaining({
        id: duplicateBacklogItem.id,
        status: "cancelled",
      }),
    ]);
    expect(storedMergedBacklogItem?.acceptanceCriteriaJson).toBe(
      JSON.stringify(["Canonical acceptance criterion", "Duplicate acceptance criterion"]),
    );
    expect(storedMergedBacklogItem?.scopeSummary).toContain(
      'Merged duplicate "Duplicate task": Duplicate scope that should be folded into the canonical task.',
    );
    expect(storedMergedBacklogItem?.riskLevel).toBe("high");
    expect(listBacklogDependencyLinksForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockedBacklogItemId: downstreamBacklogItem.id,
          blockingBacklogItemId: targetBacklogItem.id,
        }),
      ]),
    );

    closeContext(context);
  });

  it("marks pending backlog work as stale without touching active tasks", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const staleBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Outdated pending work that should leave the queue.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Stale pending task",
    });

    const markedStaleBacklogItem = markBacklogItemStaleFromPlanning(context, {
      backlogItemId: staleBacklogItem.id,
      noteText: "This path is stale after the latest product decision.",
      sourceThreadId: fixture.projectChatThread.id,
    });

    expect(markedStaleBacklogItem.status).toBe("cancelled");
    expect(getBacklogItemById(context, staleBacklogItem.id)?.status).toBe("cancelled");
    expect(() =>
      markBacklogItemStaleFromPlanning(context, {
        backlogItemId: fixture.backlogItem.id,
      }),
    ).toThrow("cannot mark stale");

    closeContext(context);
  });

  it("explains why a backlog item is next based on runnable priority", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-planning-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const nextBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Highest-priority pending item that is ready to run next.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Next pending task",
    });
    const lowerPriorityBacklogItem = createDraftBacklogItemFromPlanning(context, {
      projectId: fixture.project.id,
      scopeSummary: "Lower-priority item that is still runnable.",
      sourceThreadId: fixture.projectChatThread.id,
      title: "Later pending task",
    });

    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["This item is approved and ready."],
      backlogItemId: nextBacklogItem.id,
      priority: 80,
      readiness: "ready",
      scopeSummary: nextBacklogItem.scopeSummary ?? "",
      status: "approved",
    });
    reviseBacklogItemFromPlanning(context, {
      acceptanceCriteria: ["This item is also runnable but lower priority."],
      backlogItemId: lowerPriorityBacklogItem.id,
      priority: 40,
      readiness: "ready",
      scopeSummary: lowerPriorityBacklogItem.scopeSummary ?? "",
      status: "approved",
    });

    const explanation = explainWhyBacklogItemIsNext(context, {
      backlogItemId: nextBacklogItem.id,
    });

    expect(explanation.isNext).toBe(true);
    expect(explanation.readyForExecution).toBe(true);
    expect(explanation.activeTaskRunId).toBe(fixture.taskRun.id);
    expect(explanation.higherPriorityRunnableBacklogItemIds).toEqual([]);
    expect(explanation.explanation).toContain("approved, ready, and unblocked");
    expect(explanation.explanation).toContain(fixture.taskRun.id);

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

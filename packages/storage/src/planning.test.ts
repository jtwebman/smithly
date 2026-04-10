import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";

import { createContext, closeContext } from "./context.ts";
import {
  getBacklogItemById,
  listBacklogItemsForProject,
  listChatMessagesForThread,
  listChatThreadsForProject,
} from "./data.ts";
import { createDraftBacklogItemFromPlanning, reviseBacklogItemFromPlanning } from "./planning.ts";
import { seedInitialState } from "./seed.ts";

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
      scopeSummary: "Use MCP-backed planning actions for backlog creation and revision.",
      sourceThreadId: fixture.taskChatThread.id,
    });
    const storedBacklogItem = getBacklogItemById(context, fixture.backlogItem.id);
    const taskPlanningMessages = listChatMessagesForThread(context, fixture.taskChatThread.id);

    expect(revisedBacklogItem.scopeSummary).toBe(
      "Use MCP-backed planning actions for backlog creation and revision.",
    );
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
});

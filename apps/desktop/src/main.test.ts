import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  registerLocalProject,
  seedInitialState,
  upsertBacklogItem,
  updateProjectMetadata,
} from "@smithly/storage";

import { buildDesktopStatus, resolveDesktopThemeMode } from "./desktop-state.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("desktop bootstrap", () => {
  it("builds dashboard state from the storage context", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-desktop-bootstrap-"));

    temporaryDirectories.push(dataDirectory);

    const fixture = createInitialSeedFixture();
    const context = createContext({
      config: createConfig({
        dataDirectory,
        themePreference: "dark",
      }),
    });

    seedInitialState(context, fixture);

    expect(buildDesktopStatus(context, "dark")).toEqual({
      appVersion: "0.1.0",
      dataDirectory,
      projectCount: 1,
      projects: [
        {
          activeSessionCount: 1,
          activeTaskCount: 1,
          approvalPolicy: {
            requireApprovalForHighRiskTasks: true,
            requireApprovalForNewBacklogItems: true,
            requireApprovalForScopeChanges: true,
          },
          approvalPolicySummary: "new backlog, scope changes, high risk",
          backlogCount: 1,
          id: "project-smithly",
          metadataEntries: {
            themePreference: "system",
          },
          metadataSummary: "themePreference=system",
          name: "Smithly",
          repoPath: "/home/jt/projects/smithly",
          status: "active",
          verificationCommands: ["npm run check"],
          verificationSummary: "npm run check",
        },
      ],
      selectedProjectId: "project-smithly",
      selectedProject: {
        approvals: [
          {
            id: "approval-bootstrap-ui",
            status: "pending",
            subtitle: "Allow the initial Electron shell and xterm.js pane wiring to proceed.",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Approve shell bootstrap work",
          },
        ],
        backlogItems: [
          {
            id: "backlog-bootstrap-ui",
            status: "approved",
            subtitle:
              "Create the first desktop shell and show one managed project. | priority 90 | medium risk | human review | approved",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Bootstrap the desktop shell",
          },
        ],
        blockers: [
          {
            id: "blocker-pterm-direction",
            status: "open",
            subtitle:
              "Confirm whether pterm should be embedded directly or treated as a reference only.",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Need terminal integration decision",
          },
        ],
        events: expect.arrayContaining([
          {
            detail: "codex session is running",
            id: "worker-session-codex-bootstrap-ui",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Worker session updated",
          },
          {
            detail: "npm run check",
            id: "verification-verification-bootstrap-ui",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Verification queued",
          },
        ]),
        projectId: "project-smithly",
        projectPlanningChat: {
          kind: "project_planning",
          messages: [
            {
              bodyText: "Plan the minimal desktop shell needed for the first usable UI.",
              createdAt: "2026-04-10T07:00:00.000Z",
              id: "message-bootstrap-1",
              role: "human",
            },
            {
              bodyText: "Start with one dashboard, one xterm.js pane, and persisted project state.",
              createdAt: "2026-04-10T07:05:00.000Z",
              id: "message-bootstrap-2",
              role: "claude",
            },
          ],
          threadId: "thread-project-bootstrap-ui",
          title: "Project planning",
        },
        selectedBacklogItem: {
          acceptanceCriteria: [
            "Dashboard opens",
            "xterm.js pane is rendered",
            "state comes from SQLite",
          ],
          id: "backlog-bootstrap-ui",
          priority: 90,
          reviewMode: "human",
          riskLevel: "medium",
          scopeSummary: "Create the first desktop shell and show one managed project.",
          status: "approved",
          title: "Bootstrap the desktop shell",
        },
        selectedBacklogItemId: "backlog-bootstrap-ui",
        taskRuns: [
          {
            id: "taskrun-bootstrap-ui",
            status: "running",
            subtitle: "Scaffold the first desktop shell with one project dashboard card.",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "taskrun-bootstrap-ui",
          },
        ],
        taskPlanningChat: {
          kind: "task_planning",
          messages: [
            {
              bodyText: "Refine the backlog item before implementation begins.",
              createdAt: "2026-04-10T07:00:00.000Z",
              id: "message-task-bootstrap-1",
              role: "human",
            },
            {
              bodyText:
                "Keep the first shell narrow: one dashboard, one project list, one xterm pane, and no live PTY control yet.",
              createdAt: "2026-04-10T07:05:00.000Z",
              id: "message-task-bootstrap-2",
              role: "claude",
            },
          ],
          threadId: "thread-task-bootstrap-ui",
          title: "Task planning",
        },
      },
      resolvedThemeMode: "dark",
      themePreference: "dark",
    });

    context.db.close();
  });

  it("resolves system theme preference with a dark fallback policy", () => {
    expect(resolveDesktopThemeMode("dark", false)).toBe("dark");
    expect(resolveDesktopThemeMode("light", true)).toBe("light");
    expect(resolveDesktopThemeMode("system", true)).toBe("dark");
    expect(resolveDesktopThemeMode("system", false)).toBe("light");
  });

  it("returns an empty selected project state when no projects are registered", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-desktop-empty-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
        themePreference: "system",
      }),
    });

    expect(buildDesktopStatus(context, "light")).toEqual({
      appVersion: "0.1.0",
      dataDirectory,
      projectCount: 0,
      projects: [],
      resolvedThemeMode: "light",
      themePreference: "system",
    });

    context.db.close();
  });

  it("prefers the requested selected project when multiple projects exist", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-desktop-selection-"));
    const firstRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-repo-a-"));
    const secondRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-repo-b-"));

    temporaryDirectories.push(dataDirectory, firstRepoDirectory, secondRepoDirectory);
    mkdirSync(join(firstRepoDirectory, ".git"));
    mkdirSync(join(secondRepoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    registerLocalProject(context, {
      name: "Project Alpha",
      repoPath: firstRepoDirectory,
    });
    const secondProject = registerLocalProject(context, {
      name: "Project Beta",
      repoPath: secondRepoDirectory,
    });

    const status = buildDesktopStatus(context, "dark", secondProject.id);

    expect(status.selectedProjectId).toBe(secondProject.id);
    expect(status.selectedProject?.projectId).toBe(secondProject.id);

    context.db.close();
  });

  it("keeps an explicitly requested archived project selected", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-desktop-selection-"));
    const firstRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-repo-a-"));
    const secondRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-repo-b-"));

    temporaryDirectories.push(dataDirectory, firstRepoDirectory, secondRepoDirectory);
    mkdirSync(join(firstRepoDirectory, ".git"));
    mkdirSync(join(secondRepoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    registerLocalProject(context, {
      name: "Project Alpha",
      repoPath: firstRepoDirectory,
    });
    const secondProject = registerLocalProject(context, {
      name: "Project Beta",
      repoPath: secondRepoDirectory,
    });

    updateProjectMetadata(context, {
      projectId: secondProject.id,
      status: "archived",
    });

    const status = buildDesktopStatus(context, "dark", secondProject.id);

    expect(status.selectedProjectId).toBe(secondProject.id);
    expect(status.selectedProject?.projectId).toBe(secondProject.id);

    context.db.close();
  });

  it("prefers the requested selected backlog item within the selected project", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-desktop-backlog-selection-"));

    temporaryDirectories.push(dataDirectory);

    const fixture = createInitialSeedFixture();
    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    seedInitialState(context, fixture);
    upsertBacklogItem(context, {
      acceptanceCriteriaJson: JSON.stringify(["Second task exists"]),
      createdAt: "2026-04-10T07:10:00.000Z",
      id: "backlog-follow-up",
      priority: 70,
      projectId: fixture.project.id,
      reviewMode: "ai",
      riskLevel: "low",
      scopeSummary: "Handle another narrow desktop follow-up.",
      status: "draft",
      title: "Add a second backlog item",
      updatedAt: "2026-04-10T07:10:00.000Z",
    });

    const status = buildDesktopStatus(context, "dark", fixture.project.id, "backlog-follow-up");

    expect(status.selectedProject?.selectedBacklogItemId).toBe("backlog-follow-up");
    expect(status.selectedProject?.selectedBacklogItem?.title).toBe("Add a second backlog item");

    context.db.close();
  });
});

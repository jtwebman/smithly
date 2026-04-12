import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { createConfig, DEFAULT_PROJECT_PLANNING_LOOPS } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  listMemoryNotesForProject,
  listWorkerSessionsForProject,
  registerLocalProject,
  seedInitialState,
  upsertApproval,
  upsertBacklogItem,
  upsertWorkerSession,
  updateProjectMetadata,
} from "@smithly/storage";

import { buildDesktopStatus, resolveDesktopThemeMode } from "./desktop-state.ts";
import { SmithlyMcpService } from "./mcp-service.ts";
import {
  recoverOrphanedClaudeSessions,
  recoverProjectExecutionStates,
  resolveDesktopDataDirectoryForEnvironment,
} from "./main.ts";

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

    expect(buildDesktopStatus(context, "dark")).toEqual(
      expect.objectContaining({
      appVersion: "0.1.0",
      dataDirectory,
      dashboardDigest: {
        aiProposed: [
          {
            detail: "Smithly approval requested by claude",
            id: "proposal-approval-approval-bootstrap-ui",
            projectId: "project-smithly",
            projectName: "Smithly",
            status: "pending",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Approve shell bootstrap work",
          },
        ],
        changed: expect.arrayContaining([
          {
            detail: "Smithly codex task is running",
            id: "task-taskrun-bootstrap-ui",
            projectId: "project-smithly",
            projectName: "Smithly",
            status: "running",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Scaffold the first desktop shell with one project dashboard card.",
          },
          {
            detail: "Smithly approval requested by claude",
            id: "approval-approval-bootstrap-ui",
            projectId: "project-smithly",
            projectName: "Smithly",
            status: "pending",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Approve shell bootstrap work",
          },
        ]),
        next: [],
        running: [
          {
            detail: "1 active tasks | 1 active sessions",
            id: "running-project-smithly",
            projectId: "project-smithly",
            projectName: "Smithly",
            status: "blocked on human",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Smithly",
          },
        ],
        summary: {
          activeProjects: 1,
          archivedProjects: 0,
          pausedProjects: 0,
          readyProjects: 0,
          runningTasks: 1,
          waitingProjects: 1,
        },
        waiting: [
          {
            detail: "1 pending approvals | 1 open blockers",
            id: "waiting-project-smithly",
            projectId: "project-smithly",
            projectName: "Smithly",
            status: "blocked on human",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Smithly",
          },
        ],
      },
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
          executionState: "waiting_for_human",
          id: "project-smithly",
          metadataEntries: {
            themePreference: "system",
          },
          metadataSummary: "themePreference=system",
          mode: "blocked on human",
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
        codexSessions: [],
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
        memoryNotes: [
          {
            id: "memory-local-first-shell",
            noteType: "decision",
            status: "decision",
            subtitle:
              "Keep v1 local-first and avoid coupling xterm pane management to future multi-machine ideas.",
            timestamp: "2026-04-10T07:05:00.000Z",
            title: "Desktop shell stays local-first",
          },
        ],
        planningLoops: DEFAULT_PROJECT_PLANNING_LOOPS,
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
          actionableHumanReviewRunId: "review-bootstrap-ui",
          id: "backlog-bootstrap-ui",
          pendingHumanReviewRunId: "review-bootstrap-ui",
          priority: 90,
          reviewHistory: [
            {
              id: "review-bootstrap-ui",
              status: "queued",
              subtitle: "human review",
              timestamp: "2026-04-10T07:05:00.000Z",
              title: "human review",
            },
          ],
          reviewMode: "human",
          riskLevel: "medium",
          scopeSummary: "Create the first desktop shell and show one managed project.",
          status: "approved",
          title: "Bootstrap the desktop shell",
          verificationHistory: [
            {
              id: "verification-bootstrap-ui",
              status: "queued",
              subtitle: "npm run check",
              timestamp: "2026-04-10T07:05:00.000Z",
              title: "npm run check",
            },
          ],
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
      }),
    );

    context.db.close();
  });

  it("resolves system theme preference with a dark fallback policy", () => {
    expect(resolveDesktopThemeMode("dark", false)).toBe("dark");
    expect(resolveDesktopThemeMode("light", true)).toBe("light");
    expect(resolveDesktopThemeMode("system", true)).toBe("dark");
    expect(resolveDesktopThemeMode("system", false)).toBe("light");
  });

  it("requires an explicit test data directory in desktop test mode", () => {
    expect(() => {
      resolveDesktopDataDirectoryForEnvironment(
        {
          SMITHLY_TEST_MODE: "1",
        },
        "/real/smithly/data",
      );
    }).toThrow(
      "SMITHLY_DATA_DIRECTORY is required in test mode so tests never touch the default Smithly data directory.",
    );

    expect(
      resolveDesktopDataDirectoryForEnvironment(
        {
          SMITHLY_DATA_DIRECTORY: "/tmp/smithly-test-data",
          SMITHLY_TEST_MODE: "1",
        },
        "/real/smithly/data",
      ),
    ).toBe("/tmp/smithly-test-data");
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
      dashboardDigest: {
        aiProposed: [],
        changed: [],
        next: [],
        running: [],
        summary: {
          activeProjects: 0,
          archivedProjects: 0,
          pausedProjects: 0,
          readyProjects: 0,
          runningTasks: 0,
          waitingProjects: 0,
        },
        waiting: [],
      },
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

  it("builds cross-project dashboard digests for waiting, running, next, and AI proposals", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-desktop-digest-"));
    const readyRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-ready-repo-"));
    const proposedRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-proposed-repo-"));

    temporaryDirectories.push(dataDirectory, readyRepoDirectory, proposedRepoDirectory);
    mkdirSync(join(readyRepoDirectory, ".git"));
    mkdirSync(join(proposedRepoDirectory, ".git"));

    const fixture = createInitialSeedFixture();
    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    seedInitialState(context, fixture);
    const readyProject = registerLocalProject(context, {
      name: "Project Ready",
      repoPath: readyRepoDirectory,
    });
    const proposedProject = registerLocalProject(context, {
      name: "Project Proposed",
      repoPath: proposedRepoDirectory,
    });

    upsertBacklogItem(context, {
      acceptanceCriteriaJson: JSON.stringify(["Ready project has a runnable task"]),
      createdAt: "2026-04-10T08:00:00.000Z",
      id: "backlog-ready-next",
      priority: 88,
      projectId: readyProject.id,
      readiness: "ready",
      reviewMode: "human",
      riskLevel: "medium",
      scopeSummary: "Ready project should surface in the next-up digest.",
      status: "approved",
      title: "Ship the ready project task",
      updatedAt: "2026-04-10T08:00:00.000Z",
    });
    upsertBacklogItem(context, {
      acceptanceCriteriaJson: JSON.stringify(["Draft proposal exists"]),
      createdAt: "2026-04-10T09:00:00.000Z",
      id: "backlog-proposed-draft",
      priority: 42,
      projectId: proposedProject.id,
      readiness: "not_ready",
      reviewMode: "ai",
      riskLevel: "low",
      scopeSummary: "Draft work proposed while the project is waiting on review.",
      status: "draft",
      title: "Draft AI follow-up",
      updatedAt: "2026-04-10T09:00:00.000Z",
    });
    upsertApproval(context, {
      createdAt: "2026-04-10T09:05:00.000Z",
      detail: "Approve the AI proposed follow-up.",
      id: "approval-proposed-ai",
      projectId: proposedProject.id,
      requestedBy: "claude",
      status: "pending",
      title: "Approve proposed follow-up",
      updatedAt: "2026-04-10T09:05:00.000Z",
    });

    const status = buildDesktopStatus(context, "dark");

    expect(status.dashboardDigest.summary).toEqual({
      activeProjects: 1,
      archivedProjects: 0,
      pausedProjects: 2,
      readyProjects: 0,
      runningTasks: 1,
      waitingProjects: 1,
    });
    expect(status.dashboardDigest.waiting).toEqual(
      [
        expect.objectContaining({
          projectId: fixture.project.id,
          status: "blocked on human",
          title: "Smithly",
        }),
      ],
    );
    expect(status.dashboardDigest.running).toEqual([
      expect.objectContaining({
        projectId: fixture.project.id,
        status: "blocked on human",
        title: "Smithly",
      }),
    ]);
    expect(status.dashboardDigest.next).toEqual([
      {
        detail: "Project Ready priority 88 | human review",
        id: "next-backlog-ready-next",
        projectId: readyProject.id,
        projectName: "Project Ready",
        status: "approved",
        timestamp: "2026-04-10T08:00:00.000Z",
        title: "Ship the ready project task",
      },
    ]);
    expect(status.dashboardDigest.aiProposed).toEqual(
      expect.arrayContaining([
        {
          detail: "Project Proposed approval requested by claude",
          id: "proposal-approval-approval-proposed-ai",
          projectId: proposedProject.id,
          projectName: "Project Proposed",
          status: "pending",
          timestamp: "2026-04-10T09:05:00.000Z",
          title: "Approve proposed follow-up",
        },
        {
          detail: "Project Proposed draft backlog proposal",
          id: "proposal-backlog-backlog-proposed-draft",
          projectId: proposedProject.id,
          projectName: "Project Proposed",
          status: "ai",
          timestamp: "2026-04-10T09:00:00.000Z",
          title: "Draft AI follow-up",
        },
      ]),
    );
    expect(status.dashboardDigest.changed[0]).toEqual({
      detail: "Project Proposed approval requested by claude",
      id: "approval-approval-proposed-ai",
      projectId: proposedProject.id,
      projectName: "Project Proposed",
      status: "pending",
      timestamp: "2026-04-10T09:05:00.000Z",
      title: "Approve proposed follow-up",
    });

    context.db.close();
  });

  it("keeps paused and waiting-for-credit projects in explicit operator modes", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-desktop-project-modes-"));
    const pausedRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-mode-paused-"));
    const readyRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-mode-ready-"));
    const creditRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-mode-credit-"));

    temporaryDirectories.push(
      dataDirectory,
      pausedRepoDirectory,
      readyRepoDirectory,
      creditRepoDirectory,
    );
    mkdirSync(join(pausedRepoDirectory, ".git"));
    mkdirSync(join(readyRepoDirectory, ".git"));
    mkdirSync(join(creditRepoDirectory, ".git"));

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const pausedProject = registerLocalProject(context, {
      name: "Paused Project",
      repoPath: pausedRepoDirectory,
    });
    const readyProject = registerLocalProject(context, {
      name: "Ready Project",
      repoPath: readyRepoDirectory,
    });
    const creditProject = registerLocalProject(context, {
      name: "Credit Project",
      repoPath: creditRepoDirectory,
    });

    upsertBacklogItem(context, {
      acceptanceCriteriaJson: JSON.stringify(["Paused project backlog exists"]),
      createdAt: "2026-04-10T08:00:00.000Z",
      id: "backlog-paused-mode",
      priority: 70,
      projectId: pausedProject.id,
      readiness: "ready",
      reviewMode: "human",
      riskLevel: "low",
      scopeSummary: "Paused project should still surface as paused.",
      status: "approved",
      title: "Paused backlog item",
      updatedAt: "2026-04-10T08:00:00.000Z",
    });
    updateProjectMetadata(context, {
      projectId: readyProject.id,
      status: "active",
    });
    upsertBacklogItem(context, {
      acceptanceCriteriaJson: JSON.stringify(["Ready project backlog exists"]),
      createdAt: "2026-04-10T08:05:00.000Z",
      id: "backlog-ready-mode",
      priority: 75,
      projectId: readyProject.id,
      readiness: "ready",
      reviewMode: "human",
      riskLevel: "low",
      scopeSummary: "Ready project should surface as ready to execute.",
      status: "approved",
      title: "Ready backlog item",
      updatedAt: "2026-04-10T08:05:00.000Z",
    });
    updateProjectMetadata(context, {
      executionState: "waiting_for_credit",
      projectId: creditProject.id,
      status: "active",
    });
    upsertBacklogItem(context, {
      acceptanceCriteriaJson: JSON.stringify(["Credit project backlog exists"]),
      createdAt: "2026-04-10T08:10:00.000Z",
      id: "backlog-credit-mode",
      priority: 80,
      projectId: creditProject.id,
      readiness: "ready",
      reviewMode: "human",
      riskLevel: "medium",
      scopeSummary: "Credit-wait project should keep the credit wait mode.",
      status: "approved",
      title: "Credit backlog item",
      updatedAt: "2026-04-10T08:10:00.000Z",
    });

    const projectsByName = Object.fromEntries(
      buildDesktopStatus(context, "dark").projects.map((project) => [project.name, project.mode]),
    );

    expect(projectsByName).toMatchObject({
      "Credit Project": "waiting for credit",
      "Paused Project": "paused",
      "Ready Project": "ready to execute",
    });

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
      readiness: "not_ready",
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

  it("recovers orphaned Claude sessions on restart and records a recovery note", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-desktop-session-recovery-"));

    temporaryDirectories.push(dataDirectory);

    const fixture = createInitialSeedFixture();
    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    seedInitialState(context, fixture);
    upsertWorkerSession(context, {
      createdAt: "2026-04-10T08:00:00.000Z",
      id: "session-claude-project-recovery",
      lastHeartbeatAt: "2026-04-10T08:05:00.000Z",
      projectId: fixture.project.id,
      startedAt: "2026-04-10T08:00:00.000Z",
      status: "running",
      terminalKey: "project:project-smithly",
      transcriptRef: `chat-thread:${fixture.projectChatThread.id}|log-file:${join(
        dataDirectory,
        "claude-project.log",
      )}`,
      updatedAt: "2026-04-10T08:05:00.000Z",
      workerKind: "claude",
    });
    upsertWorkerSession(context, {
      createdAt: "2026-04-10T08:10:00.000Z",
      id: "session-claude-task-recovery",
      lastHeartbeatAt: "2026-04-10T08:15:00.000Z",
      projectId: fixture.project.id,
      startedAt: "2026-04-10T08:10:00.000Z",
      status: "blocked",
      terminalKey: "task:backlog-bootstrap-ui",
      transcriptRef: `chat-thread:${fixture.taskChatThread.id}|log-file:${join(
        dataDirectory,
        "claude-task.log",
      )}`,
      updatedAt: "2026-04-10T08:15:00.000Z",
      workerKind: "claude",
    });

    recoverOrphanedClaudeSessions(context, new Date("2026-04-10T09:00:00.000Z"));

    expect(listWorkerSessionsForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session-codex-bootstrap-ui",
          status: "failed",
          workerKind: "codex",
        }),
        expect.objectContaining({
          endedAt: "2026-04-10T09:00:00.000Z",
          id: "session-claude-project-recovery",
          lastHeartbeatAt: "2026-04-10T09:00:00.000Z",
          status: "failed",
          updatedAt: "2026-04-10T09:00:00.000Z",
          workerKind: "claude",
        }),
        expect.objectContaining({
          endedAt: "2026-04-10T09:00:00.000Z",
          id: "session-claude-task-recovery",
          lastHeartbeatAt: "2026-04-10T09:00:00.000Z",
          status: "failed",
          updatedAt: "2026-04-10T09:00:00.000Z",
          workerKind: "claude",
        }),
      ]),
    );

    expect(listMemoryNotesForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backlogItemId: fixture.backlogItem.id,
          bodyText:
            "Recovered an orphaned claude session after app restart and marked it failed before respawn.",
          id: "memory-session-recovery-session-claude-task-recovery",
          noteType: "note",
          sourceThreadId: fixture.taskChatThread.id,
          title: "Recovered orphaned claude session",
        }),
        expect.objectContaining({
          bodyText:
            "Recovered an orphaned claude session after app restart and marked it failed before respawn.",
          id: "memory-session-recovery-session-claude-project-recovery",
          noteType: "note",
          sourceThreadId: fixture.projectChatThread.id,
          title: "Recovered orphaned claude session",
        }),
      ]),
    );

    context.db.close();
  });

  it("resets active projects to paused on restart so execution only resumes on explicit play", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-desktop-project-recovery-"));

    temporaryDirectories.push(dataDirectory);

    const fixture = createInitialSeedFixture();
    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    seedInitialState(context, {
      ...fixture,
      project: {
        ...fixture.project,
        status: "active",
      },
    });

    recoverProjectExecutionStates(context, new Date("2026-04-10T09:00:00.000Z"));

    expect(buildDesktopStatus(context, "dark").projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionState: "paused",
          id: fixture.project.id,
          mode: "paused",
          status: "paused",
        }),
      ]),
    );
    expect(listMemoryNotesForProject(context, fixture.project.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bodyText:
            "Recovered project execution after app restart and reset the project to paused so work only resumes when the operator presses Play.",
          id: `memory-project-execution-recovery-${fixture.project.id}`,
          noteType: "note",
          title: "Recovered paused project execution",
        }),
      ]),
    );

    context.db.close();
  });

  it("starts a persistent local Smithly MCP service and serves scoped MCP sessions", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-desktop-mcp-service-"));

    temporaryDirectories.push(dataDirectory);

    const fixture = createInitialSeedFixture();
    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    seedInitialState(context, fixture);

    const service = new SmithlyMcpService(dataDirectory);
    const manifest = await service.start();
    const client = new Client({
      name: "smithly-desktop-test-client",
      version: "0.1.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(manifest.endpointUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${manifest.authToken}`,
          "x-smithly-project-id": fixture.project.id,
          "x-smithly-thread-id": fixture.projectChatThread.id,
        },
      },
    });

    await client.connect(transport as Transport);

    const toolResult = await client.callTool({
      name: "get_project_snapshot",
    });
    const healthResponse = await fetch(manifest.endpointUrl.replace("/mcp", "/health"));
    const unauthorizedResponse = await fetch(manifest.endpointUrl, {
      body: JSON.stringify({
        id: "1",
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: {
            name: "unauthorized",
            version: "0.1.0",
          },
          protocolVersion: "2025-06-18",
        },
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(toolResult.structuredContent).toMatchObject({
      backlogCount: 1,
      memoryNoteCount: 1,
      planningThreadCount: 2,
      projectId: fixture.project.id,
      projectName: fixture.project.name,
    });
    expect(manifest.manifestPath).toBe(join(dataDirectory, "runtime", "smithly-mcp.json"));
    expect(healthResponse.ok).toBe(true);
    expect(await healthResponse.json()).toMatchObject({
      endpointUrl: manifest.endpointUrl,
      pid: process.pid,
      status: "ok",
    });
    expect(unauthorizedResponse.status).toBe(401);

    await client.close();
    await service.stop();
    context.db.close();
  });
});

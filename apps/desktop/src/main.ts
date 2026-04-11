import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  listChatThreadsForProject,
  listProjects,
  listReviewRunsForTask,
  listTaskRunsForProject,
  listWorkerSessionsForProject,
  registerLocalProject,
  seedInitialState,
  upsertMemoryNote,
  upsertWorkerSession,
  updateProjectMetadata,
  type IStorageContext,
} from "@smithly/storage";

import {
  buildDesktopStatus,
  resolveDesktopThemeMode,
  type IDesktopStatus,
} from "./desktop-state.ts";
import { BlockerRoutingManager } from "./blocker-routing-manager.ts";
import { CodexSessionManager } from "./codex-session.ts";
import { PlanningSessionManager, type PlanningScope } from "./planning-session.ts";
import { ProjectExecutionManager } from "./project-execution.ts";
import { ReviewManager } from "./review-manager.ts";
import { TaskMergeManager } from "./task-merge-manager.ts";
import { updateReviewRunDecision } from "./task-review-policy.ts";
import { VerificationManager } from "./verification-manager.ts";

let storageContext: IStorageContext | null = null;
let planningSessionManager: PlanningSessionManager | null = null;
let codexSessionManager: CodexSessionManager | null = null;
let verificationManager: VerificationManager | null = null;
let reviewManager: ReviewManager | null = null;
let projectExecutionManager: ProjectExecutionManager | null = null;
let taskMergeManager: TaskMergeManager | null = null;
let blockerRoutingManager: BlockerRoutingManager | null = null;
let selectedProjectId: string | undefined;
let selectedBacklogItemId: string | undefined;
let isAppQuitting = false;

export interface IDesktopUiStateSnapshot {
  readonly activePlanningPaneKey?: string;
  readonly activeCodexTaskRunId?: string;
  readonly isCodingVisible?: boolean;
  readonly isOrchestrationVisible?: boolean;
  readonly isProjectWorkspaceOpen?: boolean;
  readonly openCodexTaskRunIds?: readonly string[];
  readonly openPlanningPaneKeys?: readonly string[];
  readonly selectedBacklogItemId?: string;
  readonly selectedProjectId?: string;
}

export async function bootstrapDesktopApp(): Promise<void> {
  await app.whenReady();

  storageContext = createDesktopContext();
  hydrateDesktopSelectionState(storageContext);
  recoverOrphanedClaudeSessions(storageContext);
  planningSessionManager = createPlanningSessionManager(storageContext);
  codexSessionManager = createCodexSessionManager(storageContext);
  verificationManager = createVerificationManager(storageContext);
  taskMergeManager = createTaskMergeManager(storageContext);
  reviewManager = createReviewManager(storageContext);
  blockerRoutingManager = createBlockerRoutingManager(storageContext);
  projectExecutionManager = createProjectExecutionManager(storageContext);
  registerDesktopHandlers(storageContext);
  createMainWindow();
  projectExecutionManager.resumeActiveProjects();
  blockerRoutingManager.processOpenBlockers();
  verificationManager.processQueuedRuns();
  reviewManager.processQueuedRuns();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

function createDesktopContext(): IStorageContext {
  const config = createConfig({
    dataDirectory: resolveDesktopDataDirectory(),
    themePreference: resolveDesktopThemePreference(),
    workers: {
      claude: resolveClaudeWorkerCommand(),
      codex: resolveCodexWorkerCommand(),
    },
  });
  const context = createContext({ config });

  if (resolveShouldSeedInitialState() && listProjects(context).length === 0) {
    const fixture = createInitialSeedFixture();

    seedInitialState(context, {
      ...fixture,
      project: {
        ...fixture.project,
        metadataJson:
          '{"metadata":{"themePreference":"system"},"verificationCommands":["npm run check"],"approvalPolicy":{"requireApprovalForNewBacklogItems":true,"requireApprovalForScopeChanges":true,"requireApprovalForHighRiskTasks":true}}',
        repoPath: resolveSeedProjectRepoPath(),
      },
    });
  }

  return context;
}

function createMainWindow(): BrowserWindow {
  const resolvedThemeMode = resolveDesktopThemeMode("system", nativeTheme.shouldUseDarkColors);
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: resolvedThemeMode === "dark" ? "#10151d" : "#f4efe7",
    height: 900,
    minHeight: 720,
    minWidth: 1100,
    title: "Smithly",
    width: 1440,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: resolvePreloadPath(),
    },
  });

  void window.loadFile(resolveRendererHtmlPath());
  return window;
}

function registerDesktopHandlers(context: IStorageContext): void {
  ipcMain.removeHandler("smithly:desktop-status");
  ipcMain.handle("smithly:desktop-status", (): IDesktopStatus => {
    return buildDesktopStatus(
      context,
      resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
      selectedProjectId,
      selectedBacklogItemId,
    );
  });

  ipcMain.removeHandler("smithly:project-register");
  ipcMain.handle(
    "smithly:project-register",
    (
      _event,
      input: {
        readonly approvalPolicy?: {
          readonly requireApprovalForHighRiskTasks?: boolean;
          readonly requireApprovalForNewBacklogItems?: boolean;
          readonly requireApprovalForScopeChanges?: boolean;
        };
        readonly metadata?: Readonly<Record<string, string>>;
        readonly name?: string;
        readonly repoPath: string;
        readonly verificationCommands?: readonly string[];
      },
    ): IDesktopStatus => {
      registerLocalProject(context, input);
      selectedProjectId = listProjects(context).at(-1)?.id;
      selectedBacklogItemId = undefined;
      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      );
    },
  );

  ipcMain.removeHandler("smithly:project-select");
  ipcMain.handle("smithly:project-select", (_event, projectId: string): IDesktopStatus => {
    selectedProjectId = projectId;
    selectedBacklogItemId = undefined;
    return buildDesktopStatus(
      context,
      resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
      selectedProjectId,
      selectedBacklogItemId,
    );
  });

  ipcMain.removeHandler("smithly:backlog-select");
  ipcMain.handle("smithly:backlog-select", (_event, backlogItemId: string): IDesktopStatus => {
    selectedBacklogItemId = backlogItemId;
    return buildDesktopStatus(
      context,
      resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
      selectedProjectId,
      selectedBacklogItemId,
    );
  });

  ipcMain.removeHandler("smithly:project-update");
  ipcMain.handle(
    "smithly:project-update",
    (
      _event,
      input: {
        readonly approvalPolicy?: {
          readonly requireApprovalForHighRiskTasks?: boolean;
          readonly requireApprovalForNewBacklogItems?: boolean;
          readonly requireApprovalForScopeChanges?: boolean;
        };
        readonly metadata?: Readonly<Record<string, string>>;
        readonly name?: string;
        readonly projectId: string;
        readonly repoPath: string;
        readonly verificationCommands?: readonly string[];
      },
    ): IDesktopStatus => {
      updateProjectMetadata(context, input);
      selectedProjectId = input.projectId;
      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      );
    },
  );

  ipcMain.removeHandler("smithly:project-set-status");
  ipcMain.handle(
    "smithly:project-set-status",
    (_event, projectId: string, status: "paused" | "archived"): IDesktopStatus => {
      updateProjectMetadata(context, {
        projectId,
        status,
      });

      if (status === "paused") {
        selectedProjectId = projectId;
      }

      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      );
    },
  );

  ipcMain.removeHandler("smithly:project-play");
  ipcMain.handle("smithly:project-play", (_event, projectId: string): IDesktopStatus => {
    updateProjectMetadata(context, {
      projectId,
      status: "active",
    });
    selectedProjectId = projectId;

    setTimeout(() => {
      try {
        requirePlanningSessionManager().ensureSession({
          projectId,
          scope: "project",
        });
      } finally {
        broadcastDesktopStatus(context);
      }
    }, 0);

    return buildDesktopStatus(
      context,
      resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
      selectedProjectId,
      selectedBacklogItemId,
    );
  });

  ipcMain.removeHandler("smithly:project-pause");
  ipcMain.handle("smithly:project-pause", (_event, projectId: string): IDesktopStatus => {
    void requireProjectExecutionManager()
      .pauseProject(projectId, "Operator paused the project from the desktop controls.")
      .catch(() => {
        broadcastDesktopStatus(context);
      });
    selectedProjectId = projectId;

    return buildDesktopStatus(
      context,
      resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
      selectedProjectId,
      selectedBacklogItemId,
    );
  });

  ipcMain.removeHandler("smithly:planning-session:ensure");
  ipcMain.handle(
    "smithly:planning-session:ensure",
    (_event, scope: PlanningScope, backlogItemId?: string): IDesktopStatus => {
      requirePlanningSessionManager().ensureSession({
        ...(backlogItemId !== undefined ? { backlogItemId } : {}),
        projectId: requireSelectedProjectId(context),
        scope,
      });
      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      );
    },
  );

  ipcMain.removeHandler("smithly:planning-session:submit");
  ipcMain.handle(
    "smithly:planning-session:submit",
    (
      _event,
      scope: PlanningScope,
      backlogItemId: string | undefined,
      bodyText: string,
    ): IDesktopStatus => {
      requirePlanningSessionManager().submitInput({
        ...(backlogItemId !== undefined ? { backlogItemId } : {}),
        bodyText,
        projectId: requireSelectedProjectId(context),
        scope,
      });
      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      );
    },
  );

  ipcMain.removeHandler("smithly:planning-session:write");
  ipcMain.handle("smithly:planning-session:write", (_event, terminalKey: string, data: string) => {
    requirePlanningSessionManager().writeToSession(terminalKey, data);
  });

  ipcMain.removeHandler("smithly:planning-session:resize");
  ipcMain.handle(
    "smithly:planning-session:resize",
    (_event, terminalKey: string, cols: number, rows: number) => {
      requirePlanningSessionManager().resizeSession(terminalKey, cols, rows);
    },
  );

  ipcMain.removeHandler("smithly:codex-session:start");
  ipcMain.handle(
    "smithly:codex-session:start",
    (_event, backlogItemId: string, summaryText?: string): IDesktopStatus => {
      requireCodexSessionManager().startSession({
        backlogItemId,
        projectId: requireSelectedProjectId(context),
        ...(summaryText !== undefined ? { summaryText } : {}),
      });
      selectedBacklogItemId = backlogItemId;
      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      );
    },
  );

  ipcMain.removeHandler("smithly:codex-session:ensure");
  ipcMain.handle("smithly:codex-session:ensure", (_event, taskRunId: string): IDesktopStatus => {
    requireCodexSessionManager().ensureSession(taskRunId);
    return buildDesktopStatus(
      context,
      resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
      selectedProjectId,
      selectedBacklogItemId,
    );
  });

  ipcMain.removeHandler("smithly:codex-session:write");
  ipcMain.handle("smithly:codex-session:write", (_event, terminalKey: string, data: string) => {
    requireCodexSessionManager().writeToSession(terminalKey, data);
  });

  ipcMain.removeHandler("smithly:codex-session:resize");
  ipcMain.handle(
    "smithly:codex-session:resize",
    (_event, terminalKey: string, cols: number, rows: number) => {
      requireCodexSessionManager().resizeSession(terminalKey, cols, rows);
    },
  );

  ipcMain.removeHandler("smithly:review-run:update");
  ipcMain.handle(
    "smithly:review-run:update",
    (
      _event,
      reviewRunId: string,
      status: "approved" | "changes_requested",
      summaryText?: string,
    ): IDesktopStatus => {
      updateReviewRunDecision(context, reviewRunId, status, new Date().toISOString(), summaryText);
      reviewManager?.processQueuedRuns();
      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      );
    },
  );

  ipcMain.removeHandler("smithly:review-run:defer");
  ipcMain.handle(
    "smithly:review-run:defer",
    (_event, reviewRunId: string, summaryText?: string): IDesktopStatus => {
      const reviewRun = requireReviewRun(context, reviewRunId);
      const timestamp = new Date().toISOString();

      upsertMemoryNote(context, {
        bodyText: summaryText?.trim() || "Operator deferred the review decision.",
        createdAt: timestamp,
        id: `memory-review-defer-${reviewRunId}-${randomUUID()}`,
        noteType: "note",
        projectId: reviewRun.projectId,
        taskRunId: reviewRun.taskRunId,
        title: "Review deferred",
        updatedAt: timestamp,
      });
      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      );
    },
  );

  ipcMain.removeHandler("smithly:review-run:comment");
  ipcMain.handle(
    "smithly:review-run:comment",
    (_event, reviewRunId: string, summaryText: string): IDesktopStatus => {
      const reviewRun = requireReviewRun(context, reviewRunId);
      const timestamp = new Date().toISOString();

      upsertMemoryNote(context, {
        bodyText: summaryText.trim(),
        createdAt: timestamp,
        id: `memory-review-comment-${reviewRunId}-${randomUUID()}`,
        noteType: "note",
        projectId: reviewRun.projectId,
        taskRunId: reviewRun.taskRunId,
        title: "Review comment",
        updatedAt: timestamp,
      });
      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      );
    },
  );

  ipcMain.removeHandler("smithly:task-merge");
  ipcMain.handle("smithly:task-merge", (_event, taskRunId: string): IDesktopStatus => {
    requireTaskMergeManager().mergeTaskRun(taskRunId);
    reviewManager?.processQueuedRuns();
    return buildDesktopStatus(
      context,
      resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
      selectedProjectId,
      selectedBacklogItemId,
    );
  });

  ipcMain.removeHandler("smithly:memory-note:create");
  ipcMain.handle(
    "smithly:memory-note:create",
    (
      _event,
      input: {
        readonly backlogItemId?: string;
        readonly bodyText: string;
        readonly noteType: "fact" | "decision" | "note" | "session_summary";
        readonly title: string;
      },
    ): IDesktopStatus => {
      const now = new Date().toISOString();

      upsertMemoryNote(context, {
        bodyText: input.bodyText.trim(),
        createdAt: now,
        id: `memory-desktop-${randomUUID()}`,
        noteType: input.noteType,
        projectId: requireSelectedProjectId(context),
        ...(input.backlogItemId !== undefined ? { backlogItemId: input.backlogItemId } : {}),
        title: input.title.trim(),
        updatedAt: now,
      });
      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      );
    },
  );

  ipcMain.removeHandler("smithly:ui-state:get");
  ipcMain.handle("smithly:ui-state:get", (): IDesktopUiStateSnapshot => {
    return readDesktopUiState(context.config.storage.dataDirectory);
  });

  ipcMain.removeHandler("smithly:ui-state:save");
  ipcMain.handle("smithly:ui-state:save", (_event, state: IDesktopUiStateSnapshot): void => {
    writeDesktopUiState(context.config.storage.dataDirectory, state);
  });
}

function resolveDesktopDataDirectory(): string {
  const environmentOverride = process.env.SMITHLY_DATA_DIRECTORY?.trim();

  if (environmentOverride) {
    return environmentOverride;
  }

  return join(app.getPath("userData"), "data");
}

function resolveDesktopThemePreference(): "dark" | "light" | "system" {
  const environmentOverride = process.env.SMITHLY_THEME_PREFERENCE?.trim();

  switch (environmentOverride) {
    case "dark":
    case "light":
    case "system":
      return environmentOverride;
    default:
      return "system";
  }
}

function resolveShouldSeedInitialState(): boolean {
  return process.env.SMITHLY_SEED_INITIAL_STATE?.trim() === "1";
}

function resolveSeedProjectRepoPath(): string {
  return process.env.SMITHLY_SEED_PROJECT_REPO_PATH?.trim() || process.cwd();
}

function createPlanningSessionManager(context: IStorageContext): PlanningSessionManager {
  return new PlanningSessionManager(context, (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("smithly:planning-output", event);
    }

    broadcastDesktopStatus(context);
    blockerRoutingManager?.processOpenBlockers();
    verificationManager?.processQueuedRuns();
    reviewManager?.processQueuedRuns();
  });
}

function createCodexSessionManager(context: IStorageContext): CodexSessionManager {
  return new CodexSessionManager(context, (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("smithly:codex-output", event);
    }

    broadcastDesktopStatus(context);
    blockerRoutingManager?.processOpenBlockers();
    verificationManager?.processQueuedRuns();
    reviewManager?.processQueuedRuns();
  });
}

function createVerificationManager(context: IStorageContext): VerificationManager {
  return new VerificationManager(context, {
    onUpdated: () => {
      broadcastDesktopStatus(context);
      reviewManager?.processQueuedRuns();
    },
  });
}

function createProjectExecutionManager(context: IStorageContext): ProjectExecutionManager {
  return new ProjectExecutionManager(context, {
    ensureSession(input) {
      requirePlanningSessionManager().ensureSession(input);
    },
    async requestProjectPause(projectId, reason) {
      await Promise.all([
        requirePlanningSessionManager().requestProjectPause(projectId, reason),
        requireCodexSessionManager().requestProjectPause(projectId, reason),
      ]);
    },
  });
}

function createReviewManager(context: IStorageContext): ReviewManager {
  return new ReviewManager(context, {
    mergeManager: requireTaskMergeManager(),
    onUpdated: () => {
      broadcastDesktopStatus(context);
    },
  });
}

function createTaskMergeManager(context: IStorageContext): TaskMergeManager {
  return new TaskMergeManager(context);
}

function createBlockerRoutingManager(context: IStorageContext): BlockerRoutingManager {
  return new BlockerRoutingManager(context, {
    onUpdated: () => {
      broadcastDesktopStatus(context);
    },
  });
}

function broadcastDesktopStatus(context: IStorageContext): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(
      "smithly:desktop-status-updated",
      buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
        selectedBacklogItemId,
      ),
    );
  }
}

function requirePlanningSessionManager(): PlanningSessionManager {
  if (planningSessionManager === null) {
    throw new Error("Planning session manager is not available.");
  }

  return planningSessionManager;
}

function requireCodexSessionManager(): CodexSessionManager {
  if (codexSessionManager === null) {
    throw new Error("Codex session manager is not available.");
  }

  return codexSessionManager;
}

function requireProjectExecutionManager(): ProjectExecutionManager {
  if (projectExecutionManager === null) {
    throw new Error("Project execution manager is not available.");
  }

  return projectExecutionManager;
}

function requireTaskMergeManager(): TaskMergeManager {
  if (taskMergeManager === null) {
    throw new Error("Task merge manager is not available.");
  }

  return taskMergeManager;
}

function requireSelectedProjectId(context: IStorageContext): string {
  const project =
    (selectedProjectId !== undefined
      ? listProjects(context).find((candidate) => candidate.id === selectedProjectId)
      : undefined) ?? listProjects(context).find((candidate) => candidate.status !== "archived");

  if (project === undefined) {
    throw new Error("No managed project is available.");
  }

  selectedProjectId = project.id;
  return project.id;
}

function parseWorkerCommandArgs(environmentVariableName: string): string[] | undefined {
  const rawValue = process.env[environmentVariableName]?.trim();

  if (!rawValue) {
    return undefined;
  }

  const parsedValue = JSON.parse(rawValue);

  if (!Array.isArray(parsedValue) || parsedValue.some((entry) => typeof entry !== "string")) {
    throw new Error(`${environmentVariableName} must be a JSON string array.`);
  }

  return parsedValue;
}

function resolveClaudeWorkerCommand(): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return {
    args: parseWorkerCommandArgs("SMITHLY_CLAUDE_ARGS_JSON") ?? [],
    command: process.env.SMITHLY_CLAUDE_COMMAND?.trim() || "claude",
  };
}

function resolveCodexWorkerCommand(): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return {
    args: parseWorkerCommandArgs("SMITHLY_CODEX_ARGS_JSON") ?? [],
    command: process.env.SMITHLY_CODEX_COMMAND?.trim() || "codex",
  };
}

function resolvePreloadPath(): string {
  return join(dirname(), "preload.cjs");
}

function resolveRendererHtmlPath(): string {
  return join(dirname(), "index.html");
}

export function resolveDesktopMcpServerPath(): string {
  return join(dirname(), "../../../packages/mcp-server/src/main.js");
}

function resolveDesktopUiStatePath(dataDirectory: string): string {
  return join(dataDirectory, "desktop-ui-state.json");
}

function hydrateDesktopSelectionState(context: IStorageContext): void {
  const savedUiState = readDesktopUiState(context.config.storage.dataDirectory);

  selectedProjectId = savedUiState.selectedProjectId;
  selectedBacklogItemId = savedUiState.selectedBacklogItemId;
}

function readDesktopUiState(dataDirectory: string): IDesktopUiStateSnapshot {
  const statePath = resolveDesktopUiStatePath(dataDirectory);

  if (!existsSync(statePath)) {
    return {};
  }

  try {
    const parsedValue = JSON.parse(readFileSync(statePath, "utf8")) as unknown;

    if (parsedValue === null || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return {};
    }

    const candidate = parsedValue as Record<string, unknown>;

    return {
      ...(typeof candidate.activeCodexTaskRunId === "string"
        ? { activeCodexTaskRunId: candidate.activeCodexTaskRunId }
        : {}),
      ...(typeof candidate.activePlanningPaneKey === "string"
        ? { activePlanningPaneKey: candidate.activePlanningPaneKey }
        : {}),
      ...(typeof candidate.isCodingVisible === "boolean"
        ? { isCodingVisible: candidate.isCodingVisible }
        : {}),
      ...(typeof candidate.isOrchestrationVisible === "boolean"
        ? { isOrchestrationVisible: candidate.isOrchestrationVisible }
        : {}),
      ...(typeof candidate.isProjectWorkspaceOpen === "boolean"
        ? { isProjectWorkspaceOpen: candidate.isProjectWorkspaceOpen }
        : {}),
      ...(Array.isArray(candidate.openPlanningPaneKeys) &&
      candidate.openPlanningPaneKeys.every((value) => typeof value === "string")
        ? { openPlanningPaneKeys: [...candidate.openPlanningPaneKeys] }
        : {}),
      ...(Array.isArray(candidate.openCodexTaskRunIds) &&
      candidate.openCodexTaskRunIds.every((value) => typeof value === "string")
        ? { openCodexTaskRunIds: [...candidate.openCodexTaskRunIds] }
        : {}),
      ...(typeof candidate.selectedBacklogItemId === "string"
        ? { selectedBacklogItemId: candidate.selectedBacklogItemId }
        : {}),
      ...(typeof candidate.selectedProjectId === "string"
        ? { selectedProjectId: candidate.selectedProjectId }
        : {}),
    };
  } catch {
    return {};
  }
}

function writeDesktopUiState(dataDirectory: string, state: IDesktopUiStateSnapshot): void {
  const statePath = resolveDesktopUiStatePath(dataDirectory);

  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function recoverOrphanedClaudeSessions(context: IStorageContext, now = new Date()): void {
  const timestamp = now.toISOString();

  for (const project of listProjects(context)) {
    for (const session of listWorkerSessionsForProject(context, project.id)) {
      if (
        !["claude", "codex"].includes(session.workerKind) ||
        !["starting", "running", "waiting", "blocked"].includes(session.status)
      ) {
        continue;
      }

      upsertWorkerSession(context, {
        ...session,
        endedAt: timestamp,
        lastHeartbeatAt: timestamp,
        status: "failed",
        updatedAt: timestamp,
      });

      const sourceThreadId = parseThreadIdFromTranscriptRef(session.transcriptRef);
      const thread = sourceThreadId
        ? listChatThreadsForProject(context, project.id).find(
            (candidate) => candidate.id === sourceThreadId,
          )
        : undefined;

      upsertMemoryNote(context, {
        bodyText: `Recovered an orphaned ${session.workerKind} session after app restart and marked it failed before respawn.`,
        createdAt: timestamp,
        id: `memory-session-recovery-${session.id}`,
        noteType: "note",
        projectId: project.id,
        title: `Recovered orphaned ${session.workerKind} session`,
        updatedAt: timestamp,
        ...(sourceThreadId !== undefined ? { sourceThreadId } : {}),
        ...(thread?.backlogItemId !== undefined ? { backlogItemId: thread.backlogItemId } : {}),
      });
    }
  }
}

function parseThreadIdFromTranscriptRef(transcriptRef?: string): string | undefined {
  if (transcriptRef === undefined || !transcriptRef.startsWith("chat-thread:")) {
    return undefined;
  }

  const serializedThreadId = transcriptRef.slice("chat-thread:".length).split("|", 1)[0]?.trim();
  return serializedThreadId && serializedThreadId.length > 0 ? serializedThreadId : undefined;
}

function dirname(): string {
  return fileURLToPath(new URL(".", import.meta.url));
}

if (typeof app?.on === "function") {
  app.on("before-quit", (event) => {
    if (isAppQuitting) {
      return;
    }

    event.preventDefault();
    isAppQuitting = true;

    void (async () => {
      try {
        await projectExecutionManager?.pauseAllRunningProjects(
          "Smithly is shutting down. Pause orchestration safely before exit.",
        );
      } finally {
        planningSessionManager?.dispose();
        planningSessionManager = null;
        codexSessionManager?.dispose();
        codexSessionManager = null;
        verificationManager = null;
        reviewManager = null;
        projectExecutionManager = null;
        taskMergeManager = null;
        blockerRoutingManager = null;
        storageContext?.db.close();
        storageContext = null;
        app.exit(0);
      }
    })();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

function requireReviewRun(context: IStorageContext, reviewRunId: string) {
  for (const project of listProjects(context)) {
    for (const taskRun of listTaskRunsForProject(context, project.id)) {
      const reviewRun = listReviewRunsForTask(context, taskRun.id).find((candidate) => {
        return candidate.id === reviewRunId;
      });

      if (reviewRun !== undefined) {
        return reviewRun;
      }
    }
  }

  throw new Error(`Missing review run ${reviewRunId}`);
}

if (!process.env.VITEST) {
  void bootstrapDesktopApp();
}

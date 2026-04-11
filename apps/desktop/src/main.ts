import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  listProjects,
  registerLocalProject,
  seedInitialState,
  updateProjectMetadata,
  type IStorageContext,
} from "@smithly/storage";

import {
  buildDesktopStatus,
  resolveDesktopThemeMode,
  type IDesktopStatus,
} from "./desktop-state.ts";
import { PlanningSessionManager, type PlanningScope } from "./planning-session.ts";

let storageContext: IStorageContext | null = null;
let planningSessionManager: PlanningSessionManager | null = null;
let selectedProjectId: string | undefined;

export async function bootstrapDesktopApp(): Promise<void> {
  await app.whenReady();

  storageContext = createDesktopContext();
  planningSessionManager = createPlanningSessionManager(storageContext);
  registerDesktopHandlers(storageContext);
  createMainWindow();

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
      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
      );
    },
  );

  ipcMain.removeHandler("smithly:project-select");
  ipcMain.handle("smithly:project-select", (_event, projectId: string): IDesktopStatus => {
    selectedProjectId = projectId;
    return buildDesktopStatus(
      context,
      resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
      selectedProjectId,
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
      );
    },
  );

  ipcMain.removeHandler("smithly:project-set-status");
  ipcMain.handle(
    "smithly:project-set-status",
    (_event, projectId: string, status: "active" | "archived"): IDesktopStatus => {
      updateProjectMetadata(context, {
        projectId,
        status,
      });

      if (status === "active") {
        selectedProjectId = projectId;
      }

      return buildDesktopStatus(
        context,
        resolveDesktopThemeMode(context.config.ui.themePreference, nativeTheme.shouldUseDarkColors),
        selectedProjectId,
      );
    },
  );

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
      );
    },
  );
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
      window.webContents.send(
        "smithly:desktop-status-updated",
        buildDesktopStatus(
          context,
          resolveDesktopThemeMode(
            context.config.ui.themePreference,
            nativeTheme.shouldUseDarkColors,
          ),
          selectedProjectId,
        ),
      );
    }
  });
}

function requirePlanningSessionManager(): PlanningSessionManager {
  if (planningSessionManager === null) {
    throw new Error("Planning session manager is not available.");
  }

  return planningSessionManager;
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

function resolvePreloadPath(): string {
  return join(dirname(), "preload.cjs");
}

function resolveRendererHtmlPath(): string {
  return join(dirname(), "index.html");
}

export function resolveDesktopMcpServerPath(): string {
  return join(dirname(), "../../../packages/mcp-server/src/main.js");
}

function dirname(): string {
  return fileURLToPath(new URL(".", import.meta.url));
}

app.on("window-all-closed", () => {
  planningSessionManager?.dispose();
  planningSessionManager = null;
  storageContext?.db.close();
  storageContext = null;

  if (process.platform !== "darwin") {
    app.quit();
  }
});

if (!process.env.VITEST) {
  void bootstrapDesktopApp();
}

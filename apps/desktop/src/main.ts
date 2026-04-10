import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  listProjects,
  seedInitialState,
  type IStorageContext,
} from "@smithly/storage";

import {
  buildDesktopStatus,
  resolveDesktopThemeMode,
  type IDesktopStatus,
} from "./desktop-state.ts";

let storageContext: IStorageContext | null = null;

export async function bootstrapDesktopApp(): Promise<void> {
  await app.whenReady();

  storageContext = ensureSeededDesktopContext();
  registerDesktopHandlers(storageContext);
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

function ensureSeededDesktopContext(): IStorageContext {
  const config = createConfig({
    dataDirectory: resolveDesktopDataDirectory(),
    themePreference: resolveDesktopThemePreference(),
  });
  const context = createContext({ config });

  if (listProjects(context).length === 0) {
    const fixture = createInitialSeedFixture();

    seedInitialState(context, {
      ...fixture,
      project: {
        ...fixture.project,
        metadataJson: JSON.stringify({
          themePreference: "system",
          verificationCommand: "npm run check",
        }),
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
    );
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

function resolvePreloadPath(): string {
  return join(dirname(), "preload.cjs");
}

function resolveRendererHtmlPath(): string {
  return join(dirname(), "index.html");
}

function dirname(): string {
  return fileURLToPath(new URL(".", import.meta.url));
}

app.on("window-all-closed", () => {
  storageContext?.db.close();
  storageContext = null;

  if (process.platform !== "darwin") {
    app.quit();
  }
});

if (!process.env.VITEST) {
  void bootstrapDesktopApp();
}

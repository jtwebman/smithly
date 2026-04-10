import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

import packageJson from "../../../package.json" with { type: "json" };

function createBaseEnv(dataDirectory: string, themePreference?: "dark" | "light" | "system") {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string";
      }),
    ),
    SMITHLY_CLAUDE_ARGS_JSON: JSON.stringify([resolve("apps/desktop/e2e/mock-claude.mjs")]),
    SMITHLY_CLAUDE_COMMAND: process.execPath,
    SMITHLY_DATA_DIRECTORY: dataDirectory,
    ...(themePreference !== undefined ? { SMITHLY_THEME_PREFERENCE: themePreference } : {}),
  };
}

async function launchDesktop(themePreference: "dark" | "light" | "system"): Promise<{
  readonly dataDirectory: string;
  readonly electronApp: Awaited<ReturnType<typeof electron.launch>>;
  readonly window: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>["firstWindow"]>>;
}> {
  const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-ui-"));
  const electronApp = await electron.launch({
    args: [resolve("dist/apps/desktop/src/main.js")],
    env: createBaseEnv(dataDirectory, themePreference),
  });
  const window = await electronApp.firstWindow();

  return {
    dataDirectory,
    electronApp,
    window,
  };
}

async function closeDesktop(
  electronApp: Awaited<ReturnType<typeof electron.launch>>,
  dataDirectory: string,
): Promise<void> {
  await electronApp.close();
  rmSync(dataDirectory, { force: true, recursive: true });
}

test("desktop shell shows the seeded dashboard and attaches a project planning session", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop("dark");

  try {
    await expect(window).toHaveTitle("Smithly");
    await expect(window.locator("#app-version")).toHaveText(packageJson.version);
    await expect(window.locator("#project-count")).toHaveText("1");
    await expect(window.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(window.locator("#theme-mode")).toHaveText("dark -> dark");
    await expect(window.locator("#data-directory")).toHaveText(dataDirectory);
    await expect(window.locator("#project-list")).toContainText("Smithly");
    await expect(window.locator("#backlog-list")).toContainText("Bootstrap the desktop shell");
    await expect(window.locator("#task-list")).toContainText("taskrun-bootstrap-ui");
    await expect(window.locator("#approvals-list")).toContainText("Approve shell bootstrap work");
    await expect(window.locator("#blockers-list")).toContainText(
      "Need terminal integration decision",
    );
    await expect(window.locator("#planning-title")).toHaveText("Project planning");
    await expect(window.locator("#planning-history")).toContainText(
      "Plan the minimal desktop shell needed for the first usable UI.",
    );
    await expect(window.locator("#planning-history")).toContainText(
      "Start with one dashboard, one xterm.js pane, and persisted project state.",
    );
    await expect(window.locator("#planning-status")).toContainText("project planning session");
    await expect(window.locator("#terminal-caption")).toContainText("Claude planning transcript");
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "smithly-shell: project planning transcript attached",
    );
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "mock claude ready for project planning",
    );
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("operator can send a prompt into the project planning session", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop("dark");

  try {
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "mock claude ready for project planning",
    );

    await window.locator("#planning-input").fill("Summarize the next v1 planning slice.");
    await window.locator("#planning-input-form button").click();

    await expect(window.locator("#planning-history")).toContainText(
      "Summarize the next v1 planning slice.",
    );
    await expect(window.locator("#planning-history")).toContainText(
      "claude ack: Summarize the next v1 planning slice.",
    );
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "claude ack: Summarize the next v1 planning slice.",
    );
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("operator can switch to task planning and attach a task-scoped Claude session", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop("dark");

  try {
    await window.locator("#task-planning-button").click();

    await expect(window.locator("#planning-title")).toHaveText("Task planning");
    await expect(window.locator("#selected-backlog-title")).toHaveText(
      "Bootstrap the desktop shell",
    );
    await expect(window.locator("#selected-backlog-status")).toHaveText("approved");
    await expect(window.locator("#selected-backlog-criteria")).toContainText("Dashboard opens");
    await expect(window.locator("#planning-history")).toContainText(
      "Refine the backlog item before implementation begins.",
    );
    await expect(window.locator("#planning-history")).toContainText(
      "Keep the first shell narrow: one dashboard, one project list, one xterm pane, and no live PTY control yet.",
    );
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "mock claude ready for task planning",
    );
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "focused backlog item: backlog-bootstrap-ui",
    );
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("desktop shell supports explicit light theme preference", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop("light");

  try {
    await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(window.locator("#theme-mode")).toHaveText("light -> light");
    await expect(window.locator("#terminal .xterm-rows")).toContainText("theme: light (light)");
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("desktop shell resolves system theme preference to a concrete runtime theme", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop("system");

  try {
    await expect(window.locator("#theme-mode")).toHaveText(/^system -> (dark|light)$/u);
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      /theme: (dark|light) \(system\)/u,
    );

    const htmlTheme = await window.locator("html").getAttribute("data-theme");

    expect(htmlTheme === "dark" || htmlTheme === "light").toBe(true);
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

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

test("desktop shell shows the seeded project dashboard, panels, and terminal pane", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop("dark");

  try {
    await expect(window).toHaveTitle("Smithly");
    await expect(window.locator("#app-version")).toHaveText(packageJson.version);
    await expect(window.locator("#project-count")).toHaveText("1");
    await expect(window.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(window.locator("#theme-mode")).toHaveText("dark -> dark");
    await expect(window.locator("#data-directory")).toHaveText(dataDirectory);
    await expect(window.locator("#project-list")).toContainText("Smithly");
    await expect(window.locator("#project-list")).toContainText("active");
    await expect(window.locator("#project-list")).toContainText("/home/jt/projects/smithly");
    await expect(window.locator("#task-list")).toContainText("taskrun-bootstrap-ui");
    await expect(window.locator("#task-list")).toContainText("running");
    await expect(window.locator("#backlog-list")).toContainText("Bootstrap the desktop shell");
    await expect(window.locator("#backlog-list")).toContainText("approved");
    await expect(window.locator("#approvals-list")).toContainText("Approve shell bootstrap work");
    await expect(window.locator("#approvals-list")).toContainText("pending");
    await expect(window.locator("#blockers-list")).toContainText(
      "Need terminal integration decision",
    );
    await expect(window.locator("#event-log")).toContainText("Worker session updated");
    await expect(window.locator("#event-log")).toContainText("Verification queued");
    await expect(window.locator("#shell-status")).toHaveText("Shell ready");
    await expect(window.locator("#terminal-caption")).toContainText("Read-only bootstrap pane");
    await expect(window.locator("#terminal")).toContainText(
      "smithly-shell: dashboard session attached",
    );
    await expect(window.locator("#terminal")).toContainText("theme: dark (dark)");
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("project cards and selected-project lists show exact seeded counts", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop("dark");

  try {
    const projectCards = window.locator("#project-list .project-card");
    const backlogCards = window.locator("#backlog-list .list-card");
    const taskCards = window.locator("#task-list .list-card");
    const approvalCards = window.locator("#approvals-list .list-card");
    const blockerCards = window.locator("#blockers-list .list-card");

    await expect(projectCards).toHaveCount(1);
    await expect(backlogCards).toHaveCount(1);
    await expect(taskCards).toHaveCount(1);
    await expect(approvalCards).toHaveCount(1);
    await expect(blockerCards).toHaveCount(1);

    await expect(projectCards.first()).toContainText("Active Tasks");
    await expect(projectCards.first()).toContainText("Active Sessions");
    await expect(projectCards.first()).toContainText("Backlog Items");
    await expect(projectCards.first()).toContainText("1");
    await expect(backlogCards.first()).toContainText("Create the first desktop shell");
    await expect(taskCards.first()).toContainText(
      "Scaffold the first desktop shell with one project dashboard card.",
    );
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("event log renders the seeded worker, planning, and verification activity", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop("dark");

  try {
    const events = window.locator("#event-log .event-item");

    await expect(events).toHaveCount(8);
    await expect(events.nth(0)).toContainText("Worker session updated");
    await expect(events.nth(1)).toContainText(
      "Scaffold the first desktop shell with one project dashboard card.",
    );
    await expect(events.nth(2)).toContainText("Approve shell bootstrap work");
    await expect(events.nth(5)).toContainText("Desktop shell bootstrap");
    await expect(events.nth(6)).toContainText("Verification queued");
    await expect(events.nth(7)).toContainText("Review queued");
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("desktop shell supports explicit light theme preference", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop("light");

  try {
    await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(window.locator("#theme-mode")).toHaveText("light -> light");
    await expect(window.locator("#terminal")).toContainText("theme: light (light)");
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

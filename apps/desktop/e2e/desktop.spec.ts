import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

function createBaseEnv(dataDirectory: string, themePreference?: "dark" | "light" | "system") {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string";
      }),
    ),
    SMITHLY_CLAUDE_ARGS_JSON: JSON.stringify([resolve("apps/desktop/e2e/mock-claude.mjs")]),
    SMITHLY_CLAUDE_COMMAND: process.execPath,
    SMITHLY_CODEX_ARGS_JSON: JSON.stringify([resolve("apps/desktop/e2e/mock-codex.mjs")]),
    SMITHLY_CODEX_COMMAND: process.execPath,
    SMITHLY_DATA_DIRECTORY: dataDirectory,
    SMITHLY_NODE_COMMAND: process.execPath,
    ...(themePreference !== undefined ? { SMITHLY_THEME_PREFERENCE: themePreference } : {}),
  };
}

async function launchDesktop(options: {
  readonly dataDirectory?: string;
  readonly seedInitialState?: boolean;
  readonly themePreference: "dark" | "light" | "system";
}): Promise<{
  readonly dataDirectory: string;
  readonly electronApp: Awaited<ReturnType<typeof electron.launch>>;
  readonly window: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>["firstWindow"]>>;
}> {
  const dataDirectory = options.dataDirectory ?? mkdtempSync(join(tmpdir(), "smithly-ui-"));
  const electronApp = await electron.launch({
    args: [resolve("dist/apps/desktop/src/main.js")],
    env: {
      ...createBaseEnv(dataDirectory, options.themePreference),
      ...(options.seedInitialState ? { SMITHLY_SEED_INITIAL_STATE: "1" } : {}),
    },
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
  options: {
    readonly cleanup?: boolean;
  } = {},
): Promise<void> {
  await electronApp.close();

  if (options.cleanup ?? true) {
    rmSync(dataDirectory, { force: true, recursive: true });
  }
}

test("desktop shell can register a local repo path as a managed project", async () => {
  const localRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-managed-project-"));
  mkdirSync(join(localRepoDirectory, ".git"));
  const { dataDirectory, electronApp, window } = await launchDesktop({ themePreference: "dark" });

  try {
    await expect(window.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(window.locator("#planning-status")).toContainText(
      "Register a local project to enable planning.",
    );

    await window.locator("#open-project-creator-button").click();
    await expect(window.locator("#project-creator-modal")).toBeVisible();
    await window.locator("#project-registration-path").fill(localRepoDirectory);
    await window.locator("#project-registration-name").fill("Local Fixture");
    await window.locator("#project-registration-verification").fill("npm run check\nnpm run test");
    await window.locator("#project-registration-metadata").fill("owner=jt\nstack=electron");
    await window.locator("#project-registration-approval-high-risk").uncheck();
    await window.locator("#save-project-button").click();

    await expect(window.locator("#project-creator-modal")).toBeHidden();
    await expect(window.locator("#project-list")).toContainText("Local Fixture");
    await expect(window.locator("#project-list")).toContainText(localRepoDirectory);
    await expect(window.locator("#project-list")).toContainText(
      "Verification: npm run check | npm run test",
    );
    await expect(window.locator("#project-list")).toContainText(
      "Approval: new backlog, scope changes",
    );
    await expect(window.locator("#project-list")).toContainText(
      "Metadata: owner=jt | stack=electron",
    );
    await expect(window.locator("#planning-status")).toContainText(
      "Open a project or task Claude session to begin.",
    );
  } finally {
    rmSync(localRepoDirectory, { force: true, recursive: true });
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("project dashboard can open, edit, archive, and reactivate a project", async () => {
  const firstRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-managed-project-a-"));
  const secondRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-managed-project-b-"));
  mkdirSync(join(firstRepoDirectory, ".git"));
  mkdirSync(join(secondRepoDirectory, ".git"));
  const { dataDirectory, electronApp, window } = await launchDesktop({ themePreference: "dark" });

  try {
    await window.locator("#open-project-creator-button").click();
    await window.locator("#project-registration-path").fill(firstRepoDirectory);
    await window.locator("#project-registration-name").fill("Project Alpha");
    await window.locator("#save-project-button").click();

    await window.locator("#open-project-creator-button").click();
    await window.locator("#project-registration-path").fill(secondRepoDirectory);
    await window.locator("#project-registration-name").fill("Project Beta");
    await window.locator("#save-project-button").click();

    await expect(window.locator("#project-list .project-card")).toHaveCount(2);

    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await expect(window.locator("#project-workspace")).toBeVisible();
    await expect(window.locator("#project-workspace-title")).toHaveText(
      "Project workspace: Project Alpha",
    );

    await window.locator("#show-orchestration-button").click();
    await window.locator("#project-edit-button").click();
    await expect(window.locator("#project-creator-modal")).toBeVisible();
    await expect(window.locator("#project-registration-status")).toContainText(
      "Editing Project Alpha.",
    );
    await window.locator("#project-registration-name").fill("Project Alpha Prime");
    await window.locator("#save-project-button").click();

    await expect(window.locator("#project-list")).toContainText("Project Alpha Prime");
    await expect(window.locator("#project-workspace-title")).toHaveText(
      "Project workspace: Project Alpha Prime",
    );

    await window.locator("#project-archive-button").click();
    await expect(window.locator("#project-list")).toContainText("archived");
    await expect(window.locator("#project-reactivate-button")).toBeEnabled();

    await window.locator("#project-reactivate-button").click();
    await expect(window.locator("#project-list")).toContainText("active");
  } finally {
    rmSync(firstRepoDirectory, { force: true, recursive: true });
    rmSync(secondRepoDirectory, { force: true, recursive: true });
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("desktop shell shows the seeded dashboard without auto-attaching a Claude session", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await expect(window).toHaveTitle("Smithly");
    await expect(window.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(window.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(window.locator("#project-list")).toContainText("Smithly");
    await expect(window.locator("#project-list")).toContainText("Verification: npm run check");
    await expect(window.locator("#project-list")).toContainText(
      "Approval: new backlog, scope changes, high risk",
    );
    await expect(window.locator("#project-workspace")).toBeHidden();

    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await expect(window.locator("#project-workspace")).toBeVisible();
    await expect(window.getByRole("heading", { name: "Upcoming Work" })).toBeVisible();
    await expect(window.getByRole("heading", { name: "Completed Work" })).toBeVisible();
    await expect(window.locator("#backlog-list")).toContainText("Bootstrap the desktop shell");
    await expect(window.locator("#backlog-list")).toContainText("taskrun-bootstrap-ui");
    await expect(window.locator("#backlog-list")).toContainText("priority 90");
    await expect(window.locator("#selected-backlog-meta")).toHaveText(
      "priority 90 | medium risk | human review",
    );
    await expect(window.locator("#task-list")).toContainText(
      "No completed work has been recorded yet.",
    );
    await expect(window.locator("#approvals-list")).toContainText("Approve shell bootstrap work");
    await expect(window.locator("#blockers-list")).toContainText(
      "Need terminal integration decision",
    );
    await expect(window.locator("#orchestration-shell")).toBeHidden();
    await expect(window.locator("#planning-title")).toHaveText("No planning thread");
    await expect(window.locator("#planning-history")).toContainText(
      "No planning transcript has been recorded yet.",
    );
    await expect(window.locator("#planning-status")).toContainText(
      "Open a project or task Claude session to begin.",
    );
    await expect(window.locator("#terminal-caption")).toContainText(
      "Open a Claude pane to attach a planning session.",
    );
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("operator can interact with the project planning TUI through xterm", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await window.locator("#show-orchestration-button").click();
    await window.locator("#project-planning-button").click();
    await window.locator("#terminal .xterm-screen").click();
    await window.keyboard.type("Summarize the next v1 planning slice.");
    await window.keyboard.press("Enter");
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "claude ack: Summarize the next v1 planning slice.",
    );
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("project planning can create a draft backlog item through Smithly MCP", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await window.locator("#show-orchestration-button").click();
    await window.locator("#project-planning-button").click();
    await expect(window.locator("#backlog-list .list-card")).toHaveCount(2);
    await window.locator("#terminal .xterm-screen").click();
    await window.keyboard.type(
      "create draft: Add Smithly MCP write path | Create draft backlog items through planning MCP tools.",
    );
    await window.keyboard.press("Enter");

    await expect(window.locator("#backlog-list .list-card")).toHaveCount(3);
    await expect(window.locator("#backlog-list")).toContainText("Add Smithly MCP write path");
    await expect(window.locator("#backlog-list")).toContainText(
      "Create draft backlog items through planning MCP tools.",
    );
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "claude tool create_draft_backlog_item",
    );
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("operator can switch to task planning and attach a task-scoped Claude session", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await window.locator("#show-orchestration-button").click();
    await window.locator("#backlog-list .list-card button").first().click();
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

test("task planning can revise the focused backlog item through Smithly MCP", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await window.locator("#show-orchestration-button").click();
    await window.locator("#backlog-list .list-card button").first().click();
    await window.locator("#task-planning-button").click();
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "mock claude ready for task planning",
    );
    await window.locator("#terminal .xterm-screen").click();
    await window.keyboard.type(
      "revise task: Use Smithly MCP-backed planning actions for backlog updates. | Claude can revise the task scope through MCP; Acceptance criteria are persisted in SQLite | Track the first revision path through the task planning thread. | approved | 95 | high | ai",
    );
    await window.keyboard.press("Enter");

    await expect(window.locator("#selected-backlog-scope")).toHaveText(
      "Use Smithly MCP-backed planning actions for backlog updates.",
    );
    await expect(window.locator("#selected-backlog-status")).toHaveText("approved");
    await expect(window.locator("#selected-backlog-meta")).toHaveText(
      "priority 95 | high risk | ai review",
    );
    await expect(window.locator("#selected-backlog-criteria")).toContainText(
      "Claude can revise the task scope through MCP",
    );
    await expect(window.locator("#selected-backlog-criteria")).toContainText(
      "Acceptance criteria are persisted in SQLite",
    );
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "claude tool revise_backlog_item",
    );
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("operator can keep multiple Claude panes open and switch between them", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await expect(window.locator("#planning-pane-tabs")).toContainText("No Claude panes are open.");

    await window.locator("#show-orchestration-button").click();
    await window.locator("#project-planning-button").click();
    await expect(window.locator("#planning-pane-tabs")).toContainText("Project Chat");
    await expect(window.locator("#planning-history")).toContainText(
      "Plan the minimal desktop shell needed for the first usable UI.",
    );

    await window
      .locator("#backlog-list .list-card button:has-text('Open Task Chat')")
      .first()
      .click();
    await expect(window.locator("#planning-pane-tabs")).toContainText(
      "Task: Bootstrap the desktop shell",
    );
    await expect(window.locator("#planning-history")).toContainText(
      "Refine the backlog item before implementation begins.",
    );

    await window.locator("#planning-pane-tabs .session-tab:has-text('Project Chat')").click();
    await window.locator("#project-planning-button").click();
    await expect(window.locator("#planning-title")).toHaveText("Project planning");
    await expect(window.locator("#planning-history")).toContainText(
      "Plan the minimal desktop shell needed for the first usable UI.",
    );

    await window
      .locator("#planning-pane-tabs .session-tab-row")
      .filter({ hasText: "Task: Bootstrap the desktop shell" })
      .locator(".session-tab-close")
      .click();
    await expect(window.locator("#planning-pane-tabs")).not.toContainText(
      "Task: Bootstrap the desktop shell",
    );
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("operator can start a Codex task session and attach to its terminal pane", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await expect(window.locator("#coding-shell")).toBeHidden();

    await window
      .locator("#backlog-list .list-card button:has-text('Start Coding Task')")
      .first()
      .click();

    await expect(window.locator("#coding-shell")).toBeVisible();
    await expect(window.locator("#coding-pane-tabs")).toContainText("Bootstrap the desktop shell");
    await window.locator("#codex-terminal .xterm-screen").click();
    await window.keyboard.type("Implement the next desktop slice.");
    await window.keyboard.press("Enter");
    await expect(window.locator("#codex-terminal .xterm-rows")).toContainText(
      "codex ack: Implement the next desktop slice.",
    );

    await window.keyboard.type("complete task: Finished the requested desktop slice.");
    await window.keyboard.press("Enter");
    await expect(window.locator("#backlog-list")).toContainText(
      "Finished the requested desktop slice.",
    );
    await expect(window.locator("#selected-backlog-review-history")).toContainText("human review");
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("selected backlog detail shows verification and review history with human review controls", async () => {
  const localRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-review-ui-project-"));
  mkdirSync(join(localRepoDirectory, ".git"));
  const { dataDirectory, electronApp, window } = await launchDesktop({ themePreference: "dark" });

  try {
    await window.locator("#open-project-creator-button").click();
    await window.locator("#project-registration-path").fill(localRepoDirectory);
    await window.locator("#project-registration-name").fill("Review Fixture");
    await window
      .locator("#project-registration-verification")
      .fill(`${process.execPath} -e "process.exit(0)"`);
    await window.locator("#save-project-button").click();

    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await window.locator("#show-orchestration-button").click();
    await window.locator("#project-planning-button").click();
    await window.locator("#terminal .xterm-screen").click();
    await window.keyboard.type(
      "create draft: Review-ready task | Exercise verification history and operator review controls.",
    );
    await window.keyboard.press("Enter");

    await window
      .locator("#backlog-list .list-card")
      .filter({ hasText: "Review-ready task" })
      .locator("button:has-text('Focus')")
      .click();
    await window.locator("#task-planning-button").click();
    await window.locator("#terminal .xterm-screen").click();
    await window.keyboard.type(
      "revise task: Exercise verification history and operator review controls. | Review stays blocked until the operator approves it. |  | approved | 30 | medium | human",
    );
    await window.keyboard.press("Enter");

    await window
      .locator("#backlog-list .list-card")
      .filter({ hasText: "Review-ready task" })
      .locator("button:has-text('Start Coding Task')")
      .click();
    await window.locator("#codex-terminal .xterm-screen").click();
    await window.keyboard.type("complete task: Review fixture implementation finished.");
    await window.keyboard.press("Enter");

    await expect(window.locator("#selected-backlog-review-history")).toContainText("human review");
    await expect(window.locator("#selected-backlog-review-actions")).toContainText(
      "Approve Review",
    );
    await expect(window.locator("#selected-backlog-verification-history")).toContainText(
      "Verification passed.",
    );

    await window
      .locator("#selected-backlog-review-actions button:has-text('Approve Review')")
      .click();
    await expect(window.locator("#selected-backlog-status")).toHaveText("done");
    await expect(window.locator("#selected-backlog-review-history")).toContainText("approved");
  } finally {
    rmSync(localRepoDirectory, { force: true, recursive: true });
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("desktop shell supports explicit light theme preference", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "light",
  });

  try {
    await expect(window.locator("html")).toHaveAttribute("data-theme", "light");
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("desktop shell resolves system theme preference to a concrete runtime theme", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "system",
  });

  try {
    await expect(window.locator("html")).toHaveAttribute("data-theme", /^(dark|light)$/u);
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("project creator opens as a large chat-style modal", async () => {
  const localRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-managed-project-modal-"));
  mkdirSync(join(localRepoDirectory, ".git"));
  const { dataDirectory, electronApp, window } = await launchDesktop({ themePreference: "dark" });

  try {
    await window.locator("#open-project-creator-button").click();
    await expect(window.locator("#project-creator-modal")).toBeVisible();
    await expect(window.locator("#project-creator-chat")).toContainText(
      "Start with a project name and repo path if you already have one.",
    );

    await window.locator("#project-registration-path").fill(localRepoDirectory);
    await window.locator("#project-registration-name").fill("Modal Project");
    await window.locator("#save-project-button").click();

    await expect(window.locator("#project-creator-modal")).toBeHidden();
    await expect(window.locator("#project-list")).toContainText("Modal Project");
  } finally {
    rmSync(localRepoDirectory, { force: true, recursive: true });
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("project workspace hides orchestration until requested", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await expect(window.locator("#project-workspace")).toBeVisible();
    await expect(window.locator("#orchestration-shell")).toBeHidden();

    await window.locator("#show-orchestration-button").click();
    await expect(window.locator("#orchestration-shell")).toBeVisible();

    await window.locator("#hide-orchestration-button").click();
    await expect(window.locator("#orchestration-shell")).toBeHidden();

    await window.locator("#close-project-workspace-button").click();
    await expect(window.locator("#project-workspace")).toBeHidden();
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("desktop restores the project workspace and open Claude panes after restart", async () => {
  const firstLaunch = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await firstLaunch.window
      .locator("#project-list .project-card button[data-project-id]")
      .first()
      .click();
    await firstLaunch.window.locator("#show-orchestration-button").click();
    await firstLaunch.window.locator("#project-planning-button").click();
    await expect(firstLaunch.window.locator("#planning-pane-tabs")).toContainText("Project Chat");
    await firstLaunch.window
      .locator("#backlog-list .list-card button:has-text('Open Task Chat')")
      .first()
      .click();
    await expect(firstLaunch.window.locator("#planning-pane-tabs")).toContainText(
      "Task: Bootstrap the desktop shell",
    );
    await firstLaunch.window
      .locator("#planning-pane-tabs .session-tab:has-text('Project Chat')")
      .click();
    await expect(firstLaunch.window.locator("#planning-title")).toHaveText("Project planning");
  } finally {
    await closeDesktop(firstLaunch.electronApp, firstLaunch.dataDirectory, { cleanup: false });
  }

  const secondLaunch = await launchDesktop({
    dataDirectory: firstLaunch.dataDirectory,
    themePreference: "dark",
  });

  try {
    await expect(secondLaunch.window.locator("#project-workspace")).toBeVisible();
    await expect(secondLaunch.window.locator("#orchestration-shell")).toBeVisible();
    await expect(secondLaunch.window.locator("#project-workspace-title")).toHaveText(
      "Project workspace: Smithly",
    );
    await expect(secondLaunch.window.locator("#planning-pane-tabs")).toContainText("Project Chat");
    await expect(secondLaunch.window.locator("#planning-pane-tabs")).toContainText(
      "Task: Bootstrap the desktop shell",
    );
    await expect(secondLaunch.window.locator("#planning-title")).toHaveText("Project planning");
    await secondLaunch.window.locator("#terminal .xterm-screen").click();
    await secondLaunch.window.keyboard.type("resume check");
    await secondLaunch.window.keyboard.press("Enter");
    await expect(secondLaunch.window.locator("#terminal .xterm-rows")).toContainText(
      "claude ack: resume check",
    );
  } finally {
    await closeDesktop(secondLaunch.electronApp, secondLaunch.dataDirectory);
  }
});

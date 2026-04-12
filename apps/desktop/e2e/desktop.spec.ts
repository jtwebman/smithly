import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

import { createConfig } from "@smithly/core";
import {
  createContext,
  createInitialSeedFixture,
  registerLocalProject,
  seedInitialState,
  upsertBacklogItem,
  upsertChatMessage,
  upsertChatThread,
  upsertMemoryNote,
  updateProjectMetadata,
} from "@smithly/storage";

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
    SMITHLY_GH_ARGS_JSON: JSON.stringify([resolve("apps/desktop/e2e/mock-gh.mjs")]),
    SMITHLY_GH_COMMAND: process.execPath,
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
  try {
    await electronApp.evaluate(({ app }) => {
      app.exit(0);
    });
  } catch {
    // Ignore already-closed app errors.
  }

  await Promise.race([
    electronApp.close(),
    new Promise<void>((done) => {
      setTimeout(done, 2_000);
    }),
  ]);

  if (options.cleanup ?? true) {
    rmSync(dataDirectory, { force: true, recursive: true });
  }
}

test("add project opens a bootstrap Claude session rooted at the operator home directory", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({ themePreference: "dark" });

  try {
    await expect(window.getByRole("heading", { name: "Projects" })).toBeVisible();

    await window.locator("#open-project-creator-button").click();

    await expect(window.locator("#project-workspace")).toBeVisible();
    await expect(window.locator("#orchestration-shell")).toBeVisible();
    await expect(window.locator("#project-workspace-title")).toHaveText(
      "Project bootstrap workspace",
    );
    await expect(window.locator("#project-detail-title")).toHaveText("Project bootstrap");
    await expect(window.locator("#planning-title")).toHaveText("Project bootstrap");
    await expect(window.locator("#planning-status")).toContainText("bootstrap session running");
    await expect(window.locator("#terminal-caption")).toContainText(
      "Use Claude to discuss the idea, choose a name, pick a folder, and shape the first plan.",
    );

    await window.locator("#terminal .xterm-screen").click();
    await window.keyboard.type("I want to build a new product planning tool.");
    await window.keyboard.press("Enter");
    await expect(window.locator("#terminal .xterm-rows")).toContainText(
      "claude ack: I want to build a new product planning tool.",
    );
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("completed bootstrap state restores into the managed project workspace with planning history", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-bootstrap-handoff-"));
  const repoDirectory = mkdtempSync(join(tmpdir(), "smithly-bootstrap-handoff-repo-"));

  mkdirSync(join(repoDirectory, ".git"));

  const context = createContext({
    config: createConfig({
      dataDirectory,
    }),
  });
  const project = registerLocalProject(context, {
    name: "Bootstrap Handoff",
    repoPath: repoDirectory,
  });
  const finalizedProject = updateProjectMetadata(context, {
    metadata: {
      bootstrapApprovedBacklogCount: "1",
      bootstrapCompletedAt: "2026-04-11T18:00:00.000Z",
      bootstrapOrigin: "create",
      bootstrapState: "ready_for_dashboard",
    },
    projectId: project.id,
  });

  upsertChatThread(context, {
    createdAt: "2026-04-11T17:40:00.000Z",
    id: "thread-project-bootstrap-handoff",
    kind: "project_planning",
    projectId: finalizedProject.id,
    status: "open",
    title: "Project planning",
    updatedAt: "2026-04-11T18:00:00.000Z",
  });
  upsertChatMessage(context, {
    bodyText: "We should keep the MVP narrow and operator-first.",
    createdAt: "2026-04-11T17:42:00.000Z",
    id: "message-bootstrap-handoff-1",
    metadataJson: '{"source":"bootstrap_session"}',
    role: "human",
    threadId: "thread-project-bootstrap-handoff",
  });
  upsertChatMessage(context, {
    bodyText:
      "Start with an MVP plan, initial backlog drafts, and operator approval before execution.",
    createdAt: "2026-04-11T17:45:00.000Z",
    id: "message-bootstrap-handoff-2",
    metadataJson: '{"source":"bootstrap_session"}',
    role: "claude",
    threadId: "thread-project-bootstrap-handoff",
  });
  upsertBacklogItem(context, {
    acceptanceCriteriaJson: JSON.stringify([
      "Bootstrap planning history is visible in the managed workspace",
      "The first approved task is ready before execution begins",
    ]),
    createdAt: "2026-04-11T17:50:00.000Z",
    id: "backlog-bootstrap-handoff",
    priority: 80,
    projectId: finalizedProject.id,
    readiness: "ready",
    reviewMode: "human",
    riskLevel: "medium",
    scopeSummary: "Carry the finalized bootstrap plan into the normal project workspace.",
    status: "approved",
    title: "Finalize bootstrap handoff",
    updatedAt: "2026-04-11T18:00:00.000Z",
  });
  writeFileSync(
    join(dataDirectory, "desktop-ui-state.json"),
    JSON.stringify({
      activePlanningPaneKey: "bootstrap",
      isOrchestrationVisible: true,
      isProjectWorkspaceOpen: true,
      openPlanningPaneKeys: ["bootstrap"],
    }),
  );
  context.db.close();

  const { electronApp, window } = await launchDesktop({
    dataDirectory,
    themePreference: "dark",
  });

  try {
    await expect(window.locator("#project-workspace")).toBeVisible();
    await expect(window.locator("#project-workspace-title")).toHaveText(
      "Project workspace: Bootstrap Handoff",
    );
    await expect(window.locator("#project-detail-title")).toHaveText(
      "Project orchestration: Bootstrap Handoff",
    );
    await expect(window.locator("#planning-title")).toHaveText("Project planning");
    await expect(window.locator("#planning-status")).toContainText(
      "project planning session running",
    );
    await expect(window.locator("#planning-history")).toContainText(
      "We should keep the MVP narrow and operator-first.",
    );
    await expect(window.locator("#planning-history")).toContainText(
      "Start with an MVP plan, initial backlog drafts, and operator approval before execution.",
    );
    await expect(window.locator("#backlog-list")).toContainText("Finalize bootstrap handoff");
    await expect(window.locator("#selected-backlog-title")).toHaveText(
      "Finalize bootstrap handoff",
    );
  } finally {
    rmSync(repoDirectory, { force: true, recursive: true });
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("desktop shell can register a local repo path as a managed project", async () => {
  const localRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-managed-project-"));
  mkdirSync(join(localRepoDirectory, ".git"));
  const { dataDirectory, electronApp, window } = await launchDesktop({ themePreference: "dark" });

  try {
    await expect(window.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(window.locator("#open-manual-project-creator-button")).toBeVisible();

    await window.locator("#open-manual-project-creator-button").click();
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
    await expect(window.locator("#project-list")).toContainText("paused");
    await expect(window.locator("#planning-status")).toContainText(
      "Project execution is paused. Click Play to start hidden orchestration",
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
    await window.locator("#open-manual-project-creator-button").click();
    await window.locator("#project-registration-path").fill(firstRepoDirectory);
    await window.locator("#project-registration-name").fill("Project Alpha");
    await window.locator("#save-project-button").click();

    await window.locator("#open-manual-project-creator-button").click();
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

    await expect(window.locator("#project-play-button")).toBeEnabled();
    await window.locator("#project-play-button").click();
    await expect(window.locator("#project-list")).toContainText("active");
    await expect(window.locator("#project-pause-button")).toBeEnabled();
    await window.locator("#project-pause-button").click();
    await expect(window.locator("#project-list")).toContainText("paused");

    await window.locator("#project-archive-button").click();
    await expect(window.locator("#project-list")).toContainText("archived");
    await expect(window.locator("#project-reactivate-button")).toBeEnabled();

    await window.locator("#project-reactivate-button").click();
    await expect(window.locator("#project-list")).toContainText("paused");
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
    await expect(window.locator("#project-list")).toContainText("paused");
    await expect(window.locator("#planning-status")).toContainText(
      "Project execution is paused. Click Play to start hidden orchestration",
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

test("plan and approve more opens project planning with compact project context", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await window.locator("#show-orchestration-button").click();
    await expect(window.locator("#project-planning-button")).toHaveText("Plan / Approve More");

    await window.locator("#project-planning-button").click();

    await expect(window.locator("#planning-title")).toHaveText("Project planning");
    await expect(window.locator("#planning-history")).toContainText("Project context summary:");
    await expect(window.locator("#planning-history")).toContainText("Active task context:");
    await expect(window.locator("#planning-history")).toContainText("Approved and ready work:");
    await expect(window.locator("#planning-history")).toContainText("Approved but not ready:");
  } finally {
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("project play starts hidden orchestration and pause drains it safely", async () => {
  const localRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-project-play-"));
  mkdirSync(join(localRepoDirectory, ".git"));
  const { dataDirectory, electronApp, window } = await launchDesktop({ themePreference: "dark" });

  try {
    await window.locator("#open-manual-project-creator-button").click();
    await window.locator("#project-registration-path").fill(localRepoDirectory);
    await window.locator("#project-registration-name").fill("Execution Fixture");
    await window.locator("#save-project-button").click();
    await window.locator("#project-list .project-card button[data-project-id]").first().click();

    await expect(window.locator("#project-play-button")).toBeEnabled();
    await window.locator("#project-play-button").dispatchEvent("click");

    await expect(window.locator("#project-list")).toContainText("active");
    await expect(window.locator("#planning-status")).toContainText(
      "Project execution is running in the background.",
    );

    await window.locator("#show-orchestration-button").click();
    await window.locator("#project-planning-button").click();
    await expect(window.locator("#planning-status")).toContainText(
      "project planning session running",
    );

    await window.locator("#project-pause-button").dispatchEvent("click");
    await expect(window.locator("#project-list")).toContainText("paused");
    await expect(window.locator("#planning-status")).toContainText(
      "project planning session exited",
    );
  } finally {
    rmSync(localRepoDirectory, { force: true, recursive: true });
    await closeDesktop(electronApp, dataDirectory);
  }
});

test("operator review UI supports defer, comment, approve, and merge decisions", async () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-review-ui-"));
  const repoPath = mkdtempSync(join(tmpdir(), "smithly-review-ui-repo-"));

  mkdirSync(join(repoPath, ".git"));

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
      defaultBranch: "main",
      repoPath,
    },
    reviewRun: {
      ...fixture.reviewRun,
      status: "queued",
    },
    taskRun: {
      ...fixture.taskRun,
      completedAt: "2026-04-10T07:10:00.000Z",
      status: "awaiting_review",
      updatedAt: "2026-04-10T07:10:00.000Z",
    },
    verificationRun: {
      ...fixture.verificationRun,
      completedAt: "2026-04-10T07:08:00.000Z",
      startedAt: "2026-04-10T07:07:00.000Z",
      status: "passed",
      summaryText: "Verification passed.",
      updatedAt: "2026-04-10T07:08:00.000Z",
    },
    workerSession: {
      ...fixture.workerSession,
      endedAt: "2026-04-10T07:10:00.000Z",
      status: "exited",
      updatedAt: "2026-04-10T07:10:00.000Z",
    },
  });
  upsertMemoryNote(context, {
    backlogItemId: fixture.backlogItem.id,
    bodyText: [
      "status: pr_opened",
      "branchName: smithly-bootstrap-ui",
      "defaultBranch: main",
      "pauseCommitCreated: false",
      "pullRequestUrl: https://github.com/jtwebman/smithly/pull/777",
      "updatedAt: 2026-04-10T07:10:00.000Z",
    ].join("\n"),
    createdAt: "2026-04-10T07:10:00.000Z",
    id: `memory-task-git-${fixture.taskRun.id}`,
    noteType: "note",
    projectId: fixture.project.id,
    taskRunId: fixture.taskRun.id,
    title: "Task git lifecycle",
    updatedAt: "2026-04-10T07:10:00.000Z",
  });
  context.db.close();

  const { electronApp, window } = await launchDesktop({
    dataDirectory,
    themePreference: "dark",
  });

  try {
    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await window.locator("#show-orchestration-button").click();

    const reviewActions = window.locator("#selected-backlog-review-actions");

    await reviewActions.locator("textarea").fill("Need one more pass.");
    await reviewActions.getByRole("button", { name: "Defer Review" }).click();
    await expect(window.locator("#memory-list")).toContainText("Review deferred");

    await expect(reviewActions.getByRole("button", { name: "Add Comment" })).toBeVisible();
    await expect(reviewActions.getByRole("button", { name: "Reject Review" })).toBeVisible();

    await reviewActions.locator("textarea").fill("Looks good to merge.");
    await reviewActions.getByRole("button", { name: "Approve Review" }).click();
    await expect(reviewActions.getByRole("button", { name: "Merge Pull Request" })).toBeVisible();
    await expect(window.locator("#selected-backlog-status")).toHaveText("in_progress");

    await reviewActions.getByRole("button", { name: "Merge Pull Request" }).click();
    await expect(window.locator("#selected-backlog-status")).toHaveText("done");
    await expect(window.locator("#selected-backlog-meta")).toContainText("merged");
  } finally {
    rmSync(repoPath, { force: true, recursive: true });
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
    await window.locator("#open-manual-project-creator-button").click();
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

test("manual setup opens the fallback project registration modal", async () => {
  const localRepoDirectory = mkdtempSync(join(tmpdir(), "smithly-managed-project-modal-"));
  mkdirSync(join(localRepoDirectory, ".git"));
  const { dataDirectory, electronApp, window } = await launchDesktop({ themePreference: "dark" });

  try {
    await window.locator("#open-manual-project-creator-button").click();
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

test("project workspace can write durable project memory notes", async () => {
  const { dataDirectory, electronApp, window } = await launchDesktop({
    seedInitialState: true,
    themePreference: "dark",
  });

  try {
    await window.locator("#project-list .project-card button[data-project-id]").first().click();
    await expect(window.locator("#memory-list")).toContainText("Desktop shell stays local-first");

    await window.locator("#open-memory-composer-button").click();
    await expect(window.locator("#memory-composer-modal")).toBeVisible();
    await window.locator("#memory-composer-type").selectOption("fact");
    await window.locator("#memory-composer-title").fill("Linux and macOS first");
    await window
      .locator("#memory-composer-body")
      .fill(
        "v1 only targets Linux and macOS, but the architecture should not block Windows later.",
      );
    await window.locator("#memory-composer-form button:has-text('Save Memory')").click();

    await expect(window.locator("#memory-composer-modal")).toBeHidden();
    await expect(window.locator("#memory-list")).toContainText("Linux and macOS first");
    await expect(window.locator("#memory-list")).toContainText("fact");
  } finally {
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

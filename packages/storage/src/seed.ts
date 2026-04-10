import type {
  IApprovalRecord,
  IBacklogItemRecord,
  IBlockerRecord,
  IChatMessageRecord,
  IChatThreadRecord,
  IContext,
  IMemoryNoteRecord,
  IProjectRecord,
  IReviewRunRecord,
  ITaskRunRecord,
  IVerificationRunRecord,
  IWorkerSessionRecord,
} from "@smithly/core";

import {
  upsertApproval,
  upsertBacklogItem,
  upsertBlocker,
  upsertChatMessage,
  upsertChatThread,
  upsertMemoryNote,
  upsertProject,
  upsertReviewRun,
  upsertTaskRun,
  upsertVerificationRun,
  upsertWorkerSession,
} from "./data.ts";

export interface ISeedFixture {
  readonly project: IProjectRecord;
  readonly backlogItem: IBacklogItemRecord;
  readonly workerSession: IWorkerSessionRecord;
  readonly taskRun: ITaskRunRecord;
  readonly blocker: IBlockerRecord;
  readonly approval: IApprovalRecord;
  readonly projectChatThread: IChatThreadRecord;
  readonly projectChatMessages: readonly [IChatMessageRecord, IChatMessageRecord];
  readonly taskChatThread: IChatThreadRecord;
  readonly taskChatMessages: readonly [IChatMessageRecord, IChatMessageRecord];
  readonly memoryNote: IMemoryNoteRecord;
  readonly verificationRun: IVerificationRunRecord;
  readonly reviewRun: IReviewRunRecord;
}

export function createInitialSeedFixture(): ISeedFixture {
  const createdAt = "2026-04-10T07:00:00.000Z";
  const updatedAt = "2026-04-10T07:05:00.000Z";

  return {
    approval: {
      backlogItemId: "backlog-bootstrap-ui",
      createdAt,
      detail: "Allow the initial Electron shell and xterm.js pane wiring to proceed.",
      id: "approval-bootstrap-ui",
      projectId: "project-smithly",
      requestedBy: "claude",
      status: "pending",
      taskRunId: "taskrun-bootstrap-ui",
      title: "Approve shell bootstrap work",
      updatedAt: updatedAt,
    },
    backlogItem: {
      acceptanceCriteriaJson:
        '["Dashboard opens","xterm.js pane is rendered","state comes from SQLite"]',
      createdAt,
      id: "backlog-bootstrap-ui",
      priority: 90,
      projectId: "project-smithly",
      reviewMode: "human",
      riskLevel: "medium",
      scopeSummary: "Create the first desktop shell and show one managed project.",
      status: "approved",
      title: "Bootstrap the desktop shell",
      updatedAt,
    },
    blocker: {
      backlogItemId: "backlog-bootstrap-ui",
      blockerType: "human",
      createdAt,
      detail: "Confirm whether pterm should be embedded directly or treated as a reference only.",
      id: "blocker-pterm-direction",
      projectId: "project-smithly",
      status: "open",
      taskRunId: "taskrun-bootstrap-ui",
      title: "Need terminal integration decision",
      updatedAt,
    },
    projectChatMessages: [
      {
        bodyText: "Plan the minimal desktop shell needed for the first usable UI.",
        createdAt,
        id: "message-bootstrap-1",
        metadataJson: "{}",
        role: "human",
        threadId: "thread-project-bootstrap-ui",
      },
      {
        bodyText: "Start with one dashboard, one xterm.js pane, and persisted project state.",
        createdAt: updatedAt,
        id: "message-bootstrap-2",
        metadataJson: '{"source":"claude"}',
        role: "claude",
        threadId: "thread-project-bootstrap-ui",
      },
    ],
    projectChatThread: {
      createdAt,
      id: "thread-project-bootstrap-ui",
      kind: "project_planning",
      projectId: "project-smithly",
      status: "open",
      title: "Project planning",
      updatedAt,
    },
    taskChatMessages: [
      {
        bodyText: "Refine the backlog item before implementation begins.",
        createdAt,
        id: "message-task-bootstrap-1",
        metadataJson: "{}",
        role: "human",
        threadId: "thread-task-bootstrap-ui",
      },
      {
        bodyText:
          "Keep the first shell narrow: one dashboard, one project list, one xterm pane, and no live PTY control yet.",
        createdAt: updatedAt,
        id: "message-task-bootstrap-2",
        metadataJson: '{"source":"claude"}',
        role: "claude",
        threadId: "thread-task-bootstrap-ui",
      },
    ],
    taskChatThread: {
      backlogItemId: "backlog-bootstrap-ui",
      createdAt,
      id: "thread-task-bootstrap-ui",
      kind: "task_planning",
      projectId: "project-smithly",
      status: "open",
      title: "Task planning",
      updatedAt,
    },
    memoryNote: {
      backlogItemId: "backlog-bootstrap-ui",
      bodyText:
        "Keep v1 local-first and avoid coupling xterm pane management to future multi-machine ideas.",
      createdAt,
      id: "memory-local-first-shell",
      noteType: "decision",
      projectId: "project-smithly",
      sourceThreadId: "thread-project-bootstrap-ui",
      taskRunId: "taskrun-bootstrap-ui",
      title: "Desktop shell stays local-first",
      updatedAt,
    },
    project: {
      createdAt,
      defaultBranch: "main",
      id: "project-smithly",
      metadataJson: '{"themePreference":"system","verificationCommand":"npm run check"}',
      name: "Smithly",
      repoPath: "/home/jt/projects/smithly",
      status: "active",
      updatedAt,
    },
    reviewRun: {
      createdAt,
      id: "review-bootstrap-ui",
      projectId: "project-smithly",
      reviewerKind: "human",
      status: "queued",
      taskRunId: "taskrun-bootstrap-ui",
      updatedAt,
    },
    taskRun: {
      assignedWorker: "codex",
      backlogItemId: "backlog-bootstrap-ui",
      createdAt,
      id: "taskrun-bootstrap-ui",
      projectId: "project-smithly",
      startedAt: createdAt,
      status: "running",
      summaryText: "Scaffold the first desktop shell with one project dashboard card.",
      updatedAt,
      workerSessionId: "session-codex-bootstrap-ui",
    },
    verificationRun: {
      commandText: "npm run check",
      createdAt,
      id: "verification-bootstrap-ui",
      projectId: "project-smithly",
      status: "queued",
      taskRunId: "taskrun-bootstrap-ui",
      updatedAt,
    },
    workerSession: {
      createdAt,
      id: "session-codex-bootstrap-ui",
      lastHeartbeatAt: updatedAt,
      projectId: "project-smithly",
      startedAt: createdAt,
      status: "running",
      terminalKey: "terminal-bootstrap-ui",
      transcriptRef: "codex://project-smithly/taskrun-bootstrap-ui",
      updatedAt,
      workerKind: "codex",
    },
  };
}

export function seedInitialState(
  context: IContext,
  fixture = createInitialSeedFixture(),
): ISeedFixture {
  context.db.transaction(() => {
    upsertProject(context, fixture.project);
    upsertBacklogItem(context, fixture.backlogItem);
    upsertWorkerSession(context, fixture.workerSession);
    upsertTaskRun(context, fixture.taskRun);
    upsertBlocker(context, fixture.blocker);
    upsertApproval(context, fixture.approval);
    upsertChatThread(context, fixture.projectChatThread);
    upsertChatThread(context, fixture.taskChatThread);

    for (const message of fixture.projectChatMessages) {
      upsertChatMessage(context, message);
    }

    for (const message of fixture.taskChatMessages) {
      upsertChatMessage(context, message);
    }

    upsertMemoryNote(context, fixture.memoryNote);
    upsertVerificationRun(context, fixture.verificationRun);
    upsertReviewRun(context, fixture.reviewRun);
  });

  return fixture;
}

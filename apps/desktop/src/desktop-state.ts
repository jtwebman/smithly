import type { ThemeMode, ThemePreference } from "@smithly/core";
import {
  listApprovalsForProject,
  listBacklogItemsForProject,
  listBlockersForProject,
  listChatMessagesForThread,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  listProjects,
  parseProjectMetadata,
  listReviewRunsForTask,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  listWorkerSessionsForProject,
  type IStorageContext,
} from "@smithly/storage";
import packageJson from "../../../package.json" with { type: "json" };

export interface IDesktopProjectSummary {
  readonly approvalPolicy: {
    readonly requireApprovalForHighRiskTasks: boolean;
    readonly requireApprovalForNewBacklogItems: boolean;
    readonly requireApprovalForScopeChanges: boolean;
  };
  readonly approvalPolicySummary: string;
  readonly id: string;
  readonly metadataEntries: Readonly<Record<string, string>>;
  readonly metadataSummary: string;
  readonly name: string;
  readonly repoPath: string;
  readonly status: string;
  readonly verificationCommands: readonly string[];
  readonly verificationSummary: string;
  readonly activeTaskCount: number;
  readonly activeSessionCount: number;
  readonly backlogCount: number;
}

export interface IDesktopStatus {
  readonly appVersion: string;
  readonly dataDirectory: string;
  readonly projectCount: number;
  readonly resolvedThemeMode: ThemeMode;
  readonly selectedBacklogItemId?: string;
  readonly selectedProjectId?: string;
  readonly themePreference: ThemePreference;
  readonly projects: readonly IDesktopProjectSummary[];
  readonly selectedProject?: IDesktopSelectedProject;
}

export interface IDesktopSelectedProject {
  readonly projectId: string;
  readonly backlogItems: readonly IDesktopListItem[];
  readonly taskRuns: readonly IDesktopListItem[];
  readonly codexSessions: readonly IDesktopCodexSession[];
  readonly approvals: readonly IDesktopListItem[];
  readonly blockers: readonly IDesktopListItem[];
  readonly events: readonly IDesktopEventItem[];
  readonly projectPlanningChat?: IDesktopChatThread;
  readonly projectPlanningSession?: IDesktopPlanningSession;
  readonly taskPlanningChat?: IDesktopChatThread;
  readonly taskPlanningSession?: IDesktopPlanningSession;
  readonly selectedBacklogItemId?: string;
  readonly selectedBacklogItem?: IDesktopBacklogDetail;
}

export interface IDesktopListItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly status: string;
  readonly timestamp: string;
}

export interface IDesktopEventItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly timestamp: string;
}

export interface IDesktopChatThread {
  readonly threadId: string;
  readonly title: string;
  readonly kind: string;
  readonly messages: readonly IDesktopChatMessage[];
}

export interface IDesktopChatMessage {
  readonly id: string;
  readonly role: string;
  readonly bodyText: string;
  readonly createdAt: string;
}

export interface IDesktopBacklogDetail {
  readonly id: string;
  readonly pendingHumanReviewRunId?: string;
  readonly title: string;
  readonly priority: number;
  readonly reviewHistory: readonly IDesktopListItem[];
  readonly reviewMode: string;
  readonly riskLevel: string;
  readonly status: string;
  readonly scopeSummary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verificationHistory: readonly IDesktopListItem[];
}

export interface IDesktopPlanningSession {
  readonly workerSessionId: string;
  readonly terminalKey: string;
  readonly status: string;
}

export interface IDesktopCodexSession {
  readonly backlogItemId: string;
  readonly backlogItemTitle: string;
  readonly status: string;
  readonly taskRunId: string;
  readonly terminalKey: string;
  readonly workerSessionId: string;
}

export function buildDesktopStatus(
  context: IStorageContext,
  resolvedThemeMode: ThemeMode,
  selectedProjectId?: string,
  selectedBacklogItemId?: string,
): IDesktopStatus {
  const projects = listProjects(context).map((project) => {
    const metadata = parseProjectMetadata(project);
    const activeTaskCount = listTaskRunsForProject(context, project.id).filter((taskRun) =>
      ["queued", "running", "awaiting_review"].includes(taskRun.status),
    ).length;
    const activeSessionCount = listWorkerSessionsForProject(context, project.id).filter((session) =>
      ["starting", "running", "waiting"].includes(session.status),
    ).length;
    const backlogCount = listBacklogItemsForProject(context, project.id).length;

    return {
      activeSessionCount,
      activeTaskCount,
      approvalPolicy: metadata.approvalPolicy,
      approvalPolicySummary: formatApprovalPolicySummary(metadata.approvalPolicy),
      backlogCount,
      id: project.id,
      metadataEntries: metadata.metadata,
      metadataSummary: formatMetadataSummary(metadata.metadata),
      name: project.name,
      repoPath: project.repoPath,
      status: project.status,
      verificationCommands: metadata.verificationCommands,
      verificationSummary:
        metadata.verificationCommands.length > 0
          ? metadata.verificationCommands.join(" | ")
          : "No verification commands configured",
    };
  });
  const selectedProject =
    (selectedProjectId !== undefined
      ? projects.find((project) => project.id === selectedProjectId)
      : undefined) ??
    projects.find((project) => project.status !== "archived") ??
    projects[0];

  return {
    appVersion: packageJson.version,
    dataDirectory: context.config.storage.dataDirectory,
    projectCount: projects.length,
    projects,
    resolvedThemeMode,
    ...(selectedProject !== undefined ? { selectedProjectId: selectedProject.id } : {}),
    ...(selectedBacklogItemId !== undefined ? { selectedBacklogItemId } : {}),
    ...(selectedProject !== undefined
      ? {
          selectedProject: buildSelectedProject(context, selectedProject.id, selectedBacklogItemId),
        }
      : {}),
    themePreference: context.config.ui.themePreference,
  };
}

export function resolveDesktopThemeMode(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ThemeMode {
  if (preference === "light") {
    return "light";
  }

  if (preference === "dark") {
    return "dark";
  }

  return systemPrefersDark ? "dark" : "light";
}

function buildSelectedProject(
  context: IStorageContext,
  projectId: string,
  selectedBacklogItemId?: string,
): IDesktopSelectedProject {
  const backlogItems = listBacklogItemsForProject(context, projectId);
  const taskRuns = listTaskRunsForProject(context, projectId);
  const approvals = listApprovalsForProject(context, projectId);
  const blockers = listBlockersForProject(context, projectId);
  const workerSessions = listWorkerSessionsForProject(context, projectId);
  const chatThreads = listChatThreadsForProject(context, projectId);
  const memoryNotes = listMemoryNotesForProject(context, projectId);
  const selectedBacklogItem =
    (selectedBacklogItemId !== undefined
      ? backlogItems.find((backlogItem) => backlogItem.id === selectedBacklogItemId)
      : undefined) ?? backlogItems[0];
  const projectPlanningThread = chatThreads.find((thread) => thread.kind === "project_planning");
  const taskPlanningThread = chatThreads.find((thread) => {
    return thread.kind === "task_planning" && thread.backlogItemId === selectedBacklogItem?.id;
  });
  const projectPlanningSession = projectPlanningThread
    ? findPlanningSession(workerSessions, projectPlanningThread.id)
    : undefined;
  const taskPlanningSession = taskPlanningThread
    ? findPlanningSession(workerSessions, taskPlanningThread.id)
    : undefined;
  const pendingHumanReviewRunId =
    selectedBacklogItem !== undefined
      ? findPendingHumanReviewRunId(context, projectId, selectedBacklogItem.id)
      : undefined;
  const codexSessions = taskRuns.flatMap((taskRun) => {
    const codexSession = findCodexSession(workerSessions, taskRun.id);
    const codexBacklogItem = backlogItems.find(
      (candidate) => candidate.id === taskRun.backlogItemId,
    );

    if (codexSession === undefined || codexBacklogItem === undefined) {
      return [];
    }

    return [
      {
        backlogItemId: codexBacklogItem.id,
        backlogItemTitle: codexBacklogItem.title,
        status: codexSession.status,
        taskRunId: taskRun.id,
        terminalKey: codexSession.terminalKey ?? `codex:${taskRun.id}`,
        workerSessionId: codexSession.id,
      } satisfies IDesktopCodexSession,
    ];
  });

  return {
    approvals: approvals.map((approval) => ({
      id: approval.id,
      status: approval.status,
      subtitle: approval.detail,
      timestamp: approval.updatedAt,
      title: approval.title,
    })),
    backlogItems: backlogItems.map((backlogItem) => ({
      id: backlogItem.id,
      status: backlogItem.status,
      subtitle: formatBacklogSummary(backlogItem),
      timestamp: backlogItem.updatedAt,
      title: backlogItem.title,
    })),
    blockers: blockers.map((blocker) => ({
      id: blocker.id,
      status: blocker.status,
      subtitle: blocker.detail,
      timestamp: blocker.updatedAt,
      title: blocker.title,
    })),
    codexSessions,
    events: [
      ...workerSessions.map((session) => ({
        detail: `${session.workerKind} session is ${session.status}`,
        id: `worker-${session.id}`,
        timestamp: session.updatedAt,
        title: "Worker session updated",
      })),
      ...taskRuns.map((taskRun) => ({
        detail: `${taskRun.assignedWorker} task is ${taskRun.status}`,
        id: `task-${taskRun.id}`,
        timestamp: taskRun.updatedAt,
        title: taskRun.summaryText ?? "Task run updated",
      })),
      ...approvals.map((approval) => ({
        detail: `${approval.requestedBy} requested ${approval.status}`,
        id: `approval-${approval.id}`,
        timestamp: approval.updatedAt,
        title: approval.title,
      })),
      ...blockers.map((blocker) => ({
        detail: blocker.detail,
        id: `blocker-${blocker.id}`,
        timestamp: blocker.updatedAt,
        title: blocker.title,
      })),
      ...memoryNotes.map((note) => ({
        detail: note.bodyText,
        id: `memory-${note.id}`,
        timestamp: note.updatedAt,
        title: note.title,
      })),
      ...chatThreads.map((thread) => ({
        detail: `${thread.kind} thread is ${thread.status}`,
        id: `thread-${thread.id}`,
        timestamp: thread.updatedAt,
        title: thread.title,
      })),
      ...taskRuns.flatMap((taskRun) =>
        listVerificationRunsForTask(context, taskRun.id).map((verificationRun) => ({
          detail: verificationRun.commandText,
          id: `verification-${verificationRun.id}`,
          timestamp: verificationRun.updatedAt,
          title: `Verification ${verificationRun.status}`,
        })),
      ),
      ...taskRuns.flatMap((taskRun) =>
        listReviewRunsForTask(context, taskRun.id).map((reviewRun) => ({
          detail: reviewRun.reviewerKind,
          id: `review-${reviewRun.id}`,
          timestamp: reviewRun.updatedAt,
          title: `Review ${reviewRun.status}`,
        })),
      ),
    ].sort((left, right) => right.timestamp.localeCompare(left.timestamp)),
    projectId,
    ...(selectedBacklogItem !== undefined ? { selectedBacklogItemId: selectedBacklogItem.id } : {}),
    ...(projectPlanningThread !== undefined
      ? {
          projectPlanningChat: {
            kind: projectPlanningThread.kind,
            messages: listChatMessagesForThread(context, projectPlanningThread.id).map(
              (message) => ({
                bodyText: message.bodyText,
                createdAt: message.createdAt,
                id: message.id,
                role: message.role,
              }),
            ),
            threadId: projectPlanningThread.id,
            title: projectPlanningThread.title,
          },
        }
      : {}),
    ...(projectPlanningSession !== undefined
      ? {
          projectPlanningSession: {
            status: projectPlanningSession.status,
            terminalKey: projectPlanningSession.terminalKey ?? "planning:project:missing",
            workerSessionId: projectPlanningSession.id,
          },
        }
      : {}),
    ...(selectedBacklogItem !== undefined
      ? {
          selectedBacklogItem: {
            acceptanceCriteria: parseAcceptanceCriteria(selectedBacklogItem.acceptanceCriteriaJson),
            id: selectedBacklogItem.id,
            priority: selectedBacklogItem.priority,
            reviewHistory: buildReviewHistory(context, projectId, selectedBacklogItem.id),
            reviewMode: selectedBacklogItem.reviewMode,
            riskLevel: selectedBacklogItem.riskLevel,
            scopeSummary: selectedBacklogItem.scopeSummary ?? "",
            status: selectedBacklogItem.status,
            title: selectedBacklogItem.title,
            verificationHistory: buildVerificationHistory(
              context,
              projectId,
              selectedBacklogItem.id,
            ),
            ...(pendingHumanReviewRunId !== undefined ? { pendingHumanReviewRunId } : {}),
          },
        }
      : {}),
    taskRuns: taskRuns.map((taskRun) => ({
      id: taskRun.id,
      status: taskRun.status,
      subtitle: taskRun.summaryText ?? `Assigned to ${taskRun.assignedWorker}`,
      timestamp: taskRun.updatedAt,
      title: taskRun.id,
    })),
    ...(taskPlanningThread !== undefined
      ? {
          taskPlanningChat: {
            kind: taskPlanningThread.kind,
            messages: listChatMessagesForThread(context, taskPlanningThread.id).map((message) => ({
              bodyText: message.bodyText,
              createdAt: message.createdAt,
              id: message.id,
              role: message.role,
            })),
            threadId: taskPlanningThread.id,
            title: taskPlanningThread.title,
          },
        }
      : {}),
    ...(taskPlanningSession !== undefined
      ? {
          taskPlanningSession: {
            status: taskPlanningSession.status,
            terminalKey: taskPlanningSession.terminalKey ?? "planning:task:missing",
            workerSessionId: taskPlanningSession.id,
          },
        }
      : {}),
  };
}

function buildVerificationHistory(
  context: IStorageContext,
  projectId: string,
  backlogItemId: string,
): readonly IDesktopListItem[] {
  return listTaskRunsForProject(context, projectId)
    .filter((taskRun) => taskRun.backlogItemId === backlogItemId)
    .flatMap((taskRun) =>
      listVerificationRunsForTask(context, taskRun.id).map((verificationRun) => ({
        id: verificationRun.id,
        status: verificationRun.status,
        subtitle: verificationRun.summaryText ?? verificationRun.commandText,
        timestamp: verificationRun.updatedAt,
        title: verificationRun.commandText,
      })),
    )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function buildReviewHistory(
  context: IStorageContext,
  projectId: string,
  backlogItemId: string,
): readonly IDesktopListItem[] {
  return listTaskRunsForProject(context, projectId)
    .filter((taskRun) => taskRun.backlogItemId === backlogItemId)
    .flatMap((taskRun) =>
      listReviewRunsForTask(context, taskRun.id).map((reviewRun) => ({
        id: reviewRun.id,
        status: reviewRun.status,
        subtitle: reviewRun.summaryText ?? `${reviewRun.reviewerKind} review`,
        timestamp: reviewRun.updatedAt,
        title: `${reviewRun.reviewerKind} review`,
      })),
    )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function findPendingHumanReviewRunId(
  context: IStorageContext,
  projectId: string,
  backlogItemId: string,
): string | undefined {
  return listTaskRunsForProject(context, projectId)
    .filter((taskRun) => taskRun.backlogItemId === backlogItemId)
    .flatMap((taskRun) => listReviewRunsForTask(context, taskRun.id))
    .find((reviewRun) => {
      return reviewRun.reviewerKind === "human" && ["queued", "running"].includes(reviewRun.status);
    })?.id;
}

function findPlanningSession(
  workerSessions: ReturnType<typeof listWorkerSessionsForProject>,
  threadId: string,
) {
  return [...workerSessions]
    .filter((session) => {
      return (
        session.workerKind === "claude" &&
        session.transcriptRef?.startsWith(`chat-thread:${threadId}`)
      );
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function findCodexSession(
  workerSessions: ReturnType<typeof listWorkerSessionsForProject>,
  taskRunId: string,
) {
  return [...workerSessions]
    .filter((session) => {
      return (
        session.workerKind === "codex" && session.transcriptRef?.startsWith(`task-run:${taskRunId}`)
      );
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function parseAcceptanceCriteria(serializedValue: string): string[] {
  try {
    const parsedValue = JSON.parse(serializedValue) as unknown;

    if (!Array.isArray(parsedValue)) {
      return [];
    }

    return parsedValue.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function formatApprovalPolicySummary(
  approvalPolicy: ReturnType<typeof parseProjectMetadata>["approvalPolicy"],
): string {
  const requirements: string[] = [];

  if (approvalPolicy.requireApprovalForNewBacklogItems) {
    requirements.push("new backlog");
  }

  if (approvalPolicy.requireApprovalForScopeChanges) {
    requirements.push("scope changes");
  }

  if (approvalPolicy.requireApprovalForHighRiskTasks) {
    requirements.push("high risk");
  }

  return requirements.length > 0 ? requirements.join(", ") : "No approval gates configured";
}

function formatMetadataSummary(metadata: Readonly<Record<string, string>>): string {
  const entries = Object.entries(metadata);

  if (entries.length === 0) {
    return "No metadata";
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(" | ");
}

function formatBacklogSummary(
  backlogItem: ReturnType<typeof listBacklogItemsForProject>[number],
): string {
  const scopeSummary = backlogItem.scopeSummary ?? "No scope summary yet.";
  return `${scopeSummary} | priority ${backlogItem.priority} | ${backlogItem.riskLevel} risk | ${backlogItem.reviewMode} review | ${backlogItem.status}`;
}

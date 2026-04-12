import type { ThemeMode, ThemePreference } from "@smithly/core";
import {
  getProjectById,
  listApprovalsForProject,
  listBacklogItemsForProject,
  listBlockersForProject,
  listChatMessagesForThread,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  listProjects,
  parseProjectMetadata,
  listReviewRunsForTask,
  selectNextRunnableBacklogItemForProject,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  listWorkerSessionsForProject,
  type IStorageContext,
} from "@smithly/storage";
import packageJson from "../../../package.json" with { type: "json" };
import type { IBootstrapSessionSnapshot } from "./bootstrap-session.ts";

import { resolveProjectExecutionState } from "./project-execution.ts";
import { parseTaskGitState } from "./task-git-manager.ts";

export interface IDesktopProjectSummary {
  readonly approvalPolicy: {
    readonly requireApprovalForHighRiskTasks: boolean;
    readonly requireApprovalForNewBacklogItems: boolean;
    readonly requireApprovalForScopeChanges: boolean;
  };
  readonly approvalPolicySummary: string;
  readonly executionState: string;
  readonly id: string;
  readonly metadataEntries: Readonly<Record<string, string>>;
  readonly metadataSummary: string;
  readonly mode: string;
  readonly name: string;
  readonly repoPath: string;
  readonly status: string;
  readonly verificationCommands: readonly string[];
  readonly verificationSummary: string;
  readonly activeTaskCount: number;
  readonly activeSessionCount: number;
  readonly backlogCount: number;
}

export interface IDesktopDashboardDigestSummary {
  readonly activeProjects: number;
  readonly archivedProjects: number;
  readonly pausedProjects: number;
  readonly readyProjects: number;
  readonly runningTasks: number;
  readonly waitingProjects: number;
}

export interface IDesktopDashboardDigestItem {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly detail: string;
  readonly status: string;
  readonly timestamp: string;
}

export interface IDesktopDashboardDigest {
  readonly summary: IDesktopDashboardDigestSummary;
  readonly changed: readonly IDesktopDashboardDigestItem[];
  readonly waiting: readonly IDesktopDashboardDigestItem[];
  readonly running: readonly IDesktopDashboardDigestItem[];
  readonly next: readonly IDesktopDashboardDigestItem[];
  readonly aiProposed: readonly IDesktopDashboardDigestItem[];
}

export interface IDesktopStatus {
  readonly appVersion: string;
  readonly bootstrapSession?: IBootstrapSessionSnapshot;
  readonly dataDirectory: string;
  readonly dashboardDigest: IDesktopDashboardDigest;
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
  readonly planningLoops: readonly IDesktopPlanningLoop[];
  readonly backlogItems: readonly IDesktopListItem[];
  readonly taskRuns: readonly IDesktopListItem[];
  readonly codexSessions: readonly IDesktopCodexSession[];
  readonly approvals: readonly IDesktopListItem[];
  readonly blockers: readonly IDesktopListItem[];
  readonly events: readonly IDesktopEventItem[];
  readonly memoryNotes: readonly IDesktopMemoryNoteItem[];
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

export interface IDesktopMemoryNoteItem extends IDesktopListItem {
  readonly noteType: string;
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
  readonly actionableHumanReviewRunId?: string;
  readonly mergeTaskRunId?: string;
  readonly pendingHumanReviewRunId?: string;
  readonly pullRequestStatus?: string;
  readonly pullRequestUrl?: string;
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

export interface IDesktopPlanningLoop {
  readonly enabled: boolean;
  readonly id: string;
  readonly kind: string;
  readonly prompt: string;
  readonly title: string;
  readonly trigger: string;
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
  bootstrapSession?: IBootstrapSessionSnapshot,
): IDesktopStatus {
  const projectRecords = listProjects(context);
  const projects = projectRecords.map((project) => {
    const metadata = parseProjectMetadata(project);
    const effectiveExecutionState = resolveProjectExecutionState(context, project.id);
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
      executionState: effectiveExecutionState,
      id: project.id,
      metadataEntries: metadata.metadata,
      metadataSummary: formatMetadataSummary(metadata.metadata),
      mode: resolveProjectMode(
        context,
        project.id,
        project.status,
        effectiveExecutionState,
        activeTaskCount,
      ),
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
    ...(bootstrapSession !== undefined ? { bootstrapSession } : {}),
    dataDirectory: context.config.storage.dataDirectory,
    dashboardDigest: buildDashboardDigest(context, projects),
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

function buildDashboardDigest(
  context: IStorageContext,
  projects: readonly IDesktopProjectSummary[],
): IDesktopDashboardDigest {
  return {
    aiProposed: buildAiProposedDigest(context, projects),
    changed: buildChangedDigest(context, projects),
    next: buildNextDigest(context, projects),
    running: buildRunningDigest(context, projects),
    summary: {
      activeProjects: projects.filter((project) => project.status === "active").length,
      archivedProjects: projects.filter((project) => project.status === "archived").length,
      pausedProjects: projects.filter((project) => project.status === "paused").length,
      readyProjects: projects.filter((project) => project.mode === "ready to execute").length,
      runningTasks: projects.reduce((total, project) => total + project.activeTaskCount, 0),
      waitingProjects: projects.filter((project) =>
        ["blocked on human", "blocked on external dependency", "waiting for credit"].includes(
          project.mode,
        ),
      ).length,
    },
    waiting: buildWaitingDigest(context, projects),
  };
}

function buildChangedDigest(
  context: IStorageContext,
  projects: readonly IDesktopProjectSummary[],
): readonly IDesktopDashboardDigestItem[] {
  return sortDashboardDigestItems(
    projects.flatMap((project) => {
      return [
        ...listBacklogItemsForProject(context, project.id).map((backlogItem) => ({
          detail: `${project.name} backlog is ${backlogItem.status}`,
          id: `backlog-${backlogItem.id}`,
          projectId: project.id,
          projectName: project.name,
          status: backlogItem.status,
          timestamp: backlogItem.updatedAt,
          title: backlogItem.title,
        })),
        ...listTaskRunsForProject(context, project.id).map((taskRun) => ({
          detail: `${project.name} ${taskRun.assignedWorker} task is ${taskRun.status}`,
          id: `task-${taskRun.id}`,
          projectId: project.id,
          projectName: project.name,
          status: taskRun.status,
          timestamp: taskRun.updatedAt,
          title: taskRun.summaryText ?? taskRun.id,
        })),
        ...listApprovalsForProject(context, project.id).map((approval) => ({
          detail: `${project.name} approval requested by ${approval.requestedBy}`,
          id: `approval-${approval.id}`,
          projectId: project.id,
          projectName: project.name,
          status: approval.status,
          timestamp: approval.updatedAt,
          title: approval.title,
        })),
        ...listBlockersForProject(context, project.id).map((blocker) => ({
          detail: `${project.name} blocker: ${blocker.detail}`,
          id: `blocker-${blocker.id}`,
          projectId: project.id,
          projectName: project.name,
          status: blocker.status,
          timestamp: blocker.updatedAt,
          title: blocker.title,
        })),
        ...listMemoryNotesForProject(context, project.id).map((note) => ({
          detail: `${project.name} ${note.noteType}`,
          id: `memory-${note.id}`,
          projectId: project.id,
          projectName: project.name,
          status: note.noteType,
          timestamp: note.updatedAt,
          title: note.title,
        })),
      ] satisfies readonly IDesktopDashboardDigestItem[];
    }),
  ).slice(0, 8);
}

function buildWaitingDigest(
  context: IStorageContext,
  projects: readonly IDesktopProjectSummary[],
): readonly IDesktopDashboardDigestItem[] {
  return sortDashboardDigestItems(
    projects.flatMap((project) => {
      if (
        !["blocked on human", "blocked on external dependency", "waiting for credit"].includes(
          project.mode,
        )
      ) {
        return [];
      }

      const pendingApprovals = listApprovalsForProject(context, project.id).filter((approval) => {
        return approval.status === "pending";
      });
      const openBlockers = listBlockersForProject(context, project.id).filter((blocker) => {
        return blocker.status === "open";
      });

      return [
        {
          detail: `${pendingApprovals.length} pending approvals | ${openBlockers.length} open blockers`,
          id: `waiting-${project.id}`,
          projectId: project.id,
          projectName: project.name,
          status: project.mode,
          timestamp: latestTimestamp([
            ...pendingApprovals.map((approval) => approval.updatedAt),
            ...openBlockers.map((blocker) => blocker.updatedAt),
          ]),
          title: project.name,
        },
      ] satisfies readonly IDesktopDashboardDigestItem[];
    }),
  );
}

function buildRunningDigest(
  context: IStorageContext,
  projects: readonly IDesktopProjectSummary[],
): readonly IDesktopDashboardDigestItem[] {
  return sortDashboardDigestItems(
    projects.flatMap((project) => {
      if (project.activeTaskCount === 0 && project.activeSessionCount === 0) {
        return [];
      }

      const activeTaskRuns = listTaskRunsForProject(context, project.id).filter((taskRun) => {
        return ["queued", "running", "awaiting_review"].includes(taskRun.status);
      });
      const activeSessions = listWorkerSessionsForProject(context, project.id).filter((session) => {
        return ["starting", "running", "waiting"].includes(session.status);
      });

      return [
        {
          detail: `${activeTaskRuns.length} active tasks | ${activeSessions.length} active sessions`,
          id: `running-${project.id}`,
          projectId: project.id,
          projectName: project.name,
          status: project.mode,
          timestamp: latestTimestamp([
            ...activeTaskRuns.map((taskRun) => taskRun.updatedAt),
            ...activeSessions.map((session) => session.updatedAt),
          ]),
          title: project.name,
        },
      ] satisfies readonly IDesktopDashboardDigestItem[];
    }),
  );
}

function buildNextDigest(
  context: IStorageContext,
  projects: readonly IDesktopProjectSummary[],
): readonly IDesktopDashboardDigestItem[] {
  return sortDashboardDigestItems(
    projects.flatMap((project) => {
      if (project.status === "archived") {
        return [];
      }

      const nextBacklogItem = selectNextRunnableBacklogItemForProject(context, project.id);

      if (nextBacklogItem === null) {
        return [];
      }

      return [
        {
          detail: `${project.name} priority ${nextBacklogItem.priority} | ${nextBacklogItem.reviewMode} review`,
          id: `next-${nextBacklogItem.id}`,
          projectId: project.id,
          projectName: project.name,
          status: nextBacklogItem.status,
          timestamp: nextBacklogItem.updatedAt,
          title: nextBacklogItem.title,
        },
      ] satisfies readonly IDesktopDashboardDigestItem[];
    }),
  );
}

function buildAiProposedDigest(
  context: IStorageContext,
  projects: readonly IDesktopProjectSummary[],
): readonly IDesktopDashboardDigestItem[] {
  return sortDashboardDigestItems(
    projects.flatMap((project) => {
      const draftBacklogItems = listBacklogItemsForProject(context, project.id).filter((backlogItem) => {
        return backlogItem.status === "draft";
      });
      const pendingAiApprovals = listApprovalsForProject(context, project.id).filter((approval) => {
        return approval.status === "pending" && ["claude", "codex"].includes(approval.requestedBy);
      });

      return [
        ...draftBacklogItems.map((backlogItem) => ({
          detail: `${project.name} draft backlog proposal`,
          id: `proposal-backlog-${backlogItem.id}`,
          projectId: project.id,
          projectName: project.name,
          status: backlogItem.reviewMode,
          timestamp: backlogItem.updatedAt,
          title: backlogItem.title,
        })),
        ...pendingAiApprovals.map((approval) => ({
          detail: `${project.name} approval requested by ${approval.requestedBy}`,
          id: `proposal-approval-${approval.id}`,
          projectId: project.id,
          projectName: project.name,
          status: approval.status,
          timestamp: approval.updatedAt,
          title: approval.title,
        })),
      ] satisfies readonly IDesktopDashboardDigestItem[];
    }),
  ).slice(0, 8);
}

function sortDashboardDigestItems(
  items: readonly IDesktopDashboardDigestItem[],
): readonly IDesktopDashboardDigestItem[] {
  return [...items].sort((left, right) => {
    const timestampComparison = right.timestamp.localeCompare(left.timestamp);

    if (timestampComparison !== 0) {
      return timestampComparison;
    }

    const projectComparison = left.projectName.localeCompare(right.projectName);

    if (projectComparison !== 0) {
      return projectComparison;
    }

    const titleComparison = left.title.localeCompare(right.title);

    if (titleComparison !== 0) {
      return titleComparison;
    }

    return left.id.localeCompare(right.id);
  });
}

function latestTimestamp(timestamps: readonly string[]): string {
  return [...timestamps].sort((left, right) => right.localeCompare(left))[0] ?? "";
}

export function resolveProjectMode(
  context: IStorageContext,
  projectId: string,
  projectStatus: string,
  executionState: string,
  activeTaskCount: number,
): string {
  const backlogItems = listBacklogItemsForProject(context, projectId);
  const pendingApprovals = listApprovalsForProject(context, projectId).filter((approval) => {
    return approval.status === "pending";
  });
  const openBlockers = listBlockersForProject(context, projectId).filter((blocker) => {
    return blocker.status === "open";
  });

  if (projectStatus === "archived") {
    return "archived";
  }

  if (executionState === "waiting_for_credit") {
    return "waiting for credit";
  }

  if (
    openBlockers.some((blocker) => {
      return blocker.blockerType === "helper_model" || blocker.blockerType === "system";
    })
  ) {
    return "blocked on external dependency";
  }

  if (
    pendingApprovals.length > 0 ||
    openBlockers.some((blocker) => {
      return blocker.blockerType === "human" || blocker.blockerType === "policy";
    })
  ) {
    return "blocked on human";
  }

  if (activeTaskCount > 0) {
    return "actively executing";
  }

  if (selectNextRunnableBacklogItemForProject(context, projectId) !== null) {
    return "ready to execute";
  }

  if (
    backlogItems.some((backlogItem) => {
      return ["draft", "approved", "in_progress"].includes(backlogItem.status);
    })
  ) {
    return "planning";
  }

  if (projectStatus === "paused" || executionState === "paused") {
    return "paused";
  }

  return "planning";
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
  const project = getProjectById(context, projectId);
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
  const selectedBacklogTaskRun =
    selectedBacklogItem !== undefined
      ? findLatestTaskRunForBacklogItem(taskRuns, selectedBacklogItem.id)
      : undefined;
  const selectedBacklogTaskGitState =
    selectedBacklogTaskRun !== undefined
      ? findTaskGitState(memoryNotes, selectedBacklogTaskRun.id)
      : undefined;
  const mergeTaskRunId =
    selectedBacklogTaskRun !== undefined &&
    selectedBacklogTaskGitState?.status === "pr_opened" &&
    findLatestHumanReviewRun(context, projectId, selectedBacklogItem?.id)?.status === "approved"
      ? selectedBacklogTaskRun.id
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
    memoryNotes: memoryNotes
      .map((note) => ({
        id: note.id,
        noteType: note.noteType,
        status: note.noteType,
        subtitle: note.bodyText,
        timestamp: note.updatedAt,
        title: note.title,
      }))
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp)),
    planningLoops: project === null ? [] : parseProjectMetadata(project).planningLoops,
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
            ...(pendingHumanReviewRunId !== undefined
              ? { actionableHumanReviewRunId: pendingHumanReviewRunId }
              : {}),
            ...(mergeTaskRunId !== undefined ? { mergeTaskRunId } : {}),
            ...(selectedBacklogTaskGitState?.pullRequestUrl !== undefined
              ? { pullRequestUrl: selectedBacklogTaskGitState.pullRequestUrl }
              : {}),
            ...(selectedBacklogTaskGitState !== undefined
              ? { pullRequestStatus: selectedBacklogTaskGitState.status }
              : {}),
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

function findLatestHumanReviewRun(
  context: IStorageContext,
  projectId: string,
  backlogItemId?: string,
) {
  if (backlogItemId === undefined) {
    return undefined;
  }

  return listTaskRunsForProject(context, projectId)
    .filter((taskRun) => taskRun.backlogItemId === backlogItemId)
    .flatMap((taskRun) => listReviewRunsForTask(context, taskRun.id))
    .filter((reviewRun) => reviewRun.reviewerKind === "human")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function findLatestTaskRunForBacklogItem(
  taskRuns: readonly ReturnType<typeof listTaskRunsForProject>[number][],
  backlogItemId: string,
) {
  return [...taskRuns]
    .filter((taskRun) => taskRun.backlogItemId === backlogItemId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function findTaskGitState(
  memoryNotes: readonly ReturnType<typeof listMemoryNotesForProject>[number][],
  taskRunId: string,
) {
  const note = memoryNotes.find((candidate) => candidate.id === `memory-task-git-${taskRunId}`);

  if (note === undefined) {
    return undefined;
  }

  try {
    return parseTaskGitState(note.bodyText);
  } catch {
    return undefined;
  }
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

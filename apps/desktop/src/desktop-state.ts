import type { ThemeMode, ThemePreference } from "@smithly/core";
import {
  listApprovalsForProject,
  listBacklogItemsForProject,
  listBlockersForProject,
  listChatMessagesForThread,
  listChatThreadsForProject,
  listMemoryNotesForProject,
  listProjects,
  listReviewRunsForTask,
  listTaskRunsForProject,
  listVerificationRunsForTask,
  listWorkerSessionsForProject,
  type IStorageContext,
} from "@smithly/storage";
import packageJson from "../../../package.json" with { type: "json" };

export interface IDesktopProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly repoPath: string;
  readonly status: string;
  readonly activeTaskCount: number;
  readonly activeSessionCount: number;
  readonly backlogCount: number;
}

export interface IDesktopStatus {
  readonly appVersion: string;
  readonly dataDirectory: string;
  readonly projectCount: number;
  readonly resolvedThemeMode: ThemeMode;
  readonly themePreference: ThemePreference;
  readonly projects: readonly IDesktopProjectSummary[];
  readonly selectedProject?: IDesktopSelectedProject;
}

export interface IDesktopSelectedProject {
  readonly projectId: string;
  readonly backlogItems: readonly IDesktopListItem[];
  readonly taskRuns: readonly IDesktopListItem[];
  readonly approvals: readonly IDesktopListItem[];
  readonly blockers: readonly IDesktopListItem[];
  readonly events: readonly IDesktopEventItem[];
  readonly projectPlanningChat?: IDesktopChatThread;
  readonly projectPlanningSession?: IDesktopPlanningSession;
  readonly taskPlanningChat?: IDesktopChatThread;
  readonly taskPlanningSession?: IDesktopPlanningSession;
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
  readonly title: string;
  readonly status: string;
  readonly scopeSummary: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface IDesktopPlanningSession {
  readonly workerSessionId: string;
  readonly terminalKey: string;
  readonly status: string;
}

export function buildDesktopStatus(
  context: IStorageContext,
  resolvedThemeMode: ThemeMode,
): IDesktopStatus {
  const projects = listProjects(context).map((project) => {
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
      backlogCount,
      id: project.id,
      name: project.name,
      repoPath: project.repoPath,
      status: project.status,
    };
  });
  const selectedProject = projects.find((project) => project.status !== "archived") ?? projects[0];

  return {
    appVersion: packageJson.version,
    dataDirectory: context.config.storage.dataDirectory,
    projectCount: projects.length,
    projects,
    resolvedThemeMode,
    ...(selectedProject !== undefined
      ? { selectedProject: buildSelectedProject(context, selectedProject.id) }
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
): IDesktopSelectedProject {
  const backlogItems = listBacklogItemsForProject(context, projectId);
  const taskRuns = listTaskRunsForProject(context, projectId);
  const approvals = listApprovalsForProject(context, projectId);
  const blockers = listBlockersForProject(context, projectId);
  const workerSessions = listWorkerSessionsForProject(context, projectId);
  const chatThreads = listChatThreadsForProject(context, projectId);
  const memoryNotes = listMemoryNotesForProject(context, projectId);
  const selectedBacklogItem = backlogItems[0];
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
      subtitle: backlogItem.scopeSummary ?? "No scope summary yet.",
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
            scopeSummary: selectedBacklogItem.scopeSummary ?? "",
            status: selectedBacklogItem.status,
            title: selectedBacklogItem.title,
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

function findPlanningSession(
  workerSessions: ReturnType<typeof listWorkerSessionsForProject>,
  threadId: string,
) {
  return [...workerSessions]
    .filter((session) => {
      return session.workerKind === "claude" && session.transcriptRef === `chat-thread:${threadId}`;
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

/// <reference lib="dom" />

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

type PlanningScope = "project" | "task";
type PlanningPaneScope = PlanningScope | "bootstrap";
type SessionPaneKey = "bootstrap" | `project:${string}` | `task:${string}`;

interface DesktopProjectSummary {
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

interface DesktopProjectRegistrationInput {
  readonly approvalPolicy: {
    readonly requireApprovalForHighRiskTasks: boolean;
    readonly requireApprovalForNewBacklogItems: boolean;
    readonly requireApprovalForScopeChanges: boolean;
  };
  readonly metadata: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly planningLoops: readonly DesktopPlanningLoop[];
  readonly repoPath: string;
  readonly verificationCommands: readonly string[];
}

interface DesktopStatus {
  readonly appVersion: string;
  readonly bootstrapSession?: DesktopBootstrapSession;
  readonly dataDirectory: string;
  readonly dashboardDigest: DesktopDashboardDigest;
  readonly projectCount: number;
  readonly resolvedThemeMode: "dark" | "light";
  readonly selectedBacklogItemId?: string;
  readonly selectedProjectId?: string;
  readonly themePreference: "dark" | "light" | "system";
  readonly projects: readonly DesktopProjectSummary[];
  readonly selectedProject?: {
    readonly projectId: string;
    readonly backlogItems: readonly DesktopListItem[];
    readonly taskRuns: readonly DesktopListItem[];
    readonly codexSessions: readonly DesktopCodexSession[];
    readonly approvals: readonly DesktopListItem[];
    readonly blockers: readonly DesktopListItem[];
    readonly events: readonly DesktopEventItem[];
    readonly memoryNotes: readonly DesktopMemoryNoteItem[];
    readonly planningLoops: readonly DesktopPlanningLoop[];
    readonly projectPlanningChat?: DesktopChatThread;
    readonly projectPlanningSession?: DesktopPlanningSession;
    readonly taskPlanningChat?: DesktopChatThread;
    readonly taskPlanningSession?: DesktopPlanningSession;
    readonly selectedBacklogItemId?: string;
    readonly selectedBacklogItem?: DesktopBacklogDetail;
  };
}

interface DesktopDashboardDigestSummary {
  readonly activeProjects: number;
  readonly archivedProjects: number;
  readonly pausedProjects: number;
  readonly readyProjects: number;
  readonly runningTasks: number;
  readonly waitingProjects: number;
}

interface DesktopDashboardDigestItem {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly title: string;
  readonly detail: string;
  readonly status: string;
  readonly timestamp: string;
}

interface DesktopDashboardDigest {
  readonly summary: DesktopDashboardDigestSummary;
  readonly changed: readonly DesktopDashboardDigestItem[];
  readonly waiting: readonly DesktopDashboardDigestItem[];
  readonly running: readonly DesktopDashboardDigestItem[];
  readonly next: readonly DesktopDashboardDigestItem[];
  readonly aiProposed: readonly DesktopDashboardDigestItem[];
}

interface DesktopListItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly status: string;
  readonly timestamp: string;
}

interface DesktopEventItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly timestamp: string;
}

interface DesktopMemoryNoteItem extends DesktopListItem {
  readonly noteType: string;
}

interface DesktopChatThread {
  readonly threadId: string;
  readonly title: string;
  readonly kind: string;
  readonly messages: readonly DesktopChatMessage[];
}

interface DesktopChatMessage {
  readonly id: string;
  readonly role: string;
  readonly bodyText: string;
  readonly createdAt: string;
}

interface DesktopBacklogDetail {
  readonly actionableHumanReviewRunId?: string;
  readonly id: string;
  readonly mergeTaskRunId?: string;
  readonly pendingHumanReviewRunId?: string;
  readonly pullRequestStatus?: string;
  readonly pullRequestUrl?: string;
  readonly title: string;
  readonly priority: number;
  readonly reviewHistory: readonly DesktopListItem[];
  readonly reviewMode: string;
  readonly riskLevel: string;
  readonly status: string;
  readonly scopeSummary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verificationHistory: readonly DesktopListItem[];
}

interface DesktopPlanningLoop {
  readonly enabled: boolean;
  readonly id: string;
  readonly kind: "idle_backlog_generation" | "security_audit" | "best_practices" | "custom";
  readonly prompt: string;
  readonly title: string;
  readonly trigger: "idle" | "blocked_or_waiting";
}

const DEFAULT_PROJECT_PLANNING_LOOPS: readonly DesktopPlanningLoop[] = [
  {
    enabled: true,
    id: "loop-idle-backlog-generation",
    kind: "idle_backlog_generation",
    prompt: [
      "Run the default idle backlog-generation loop for this project.",
      "The project is blocked or waiting on something external before coding can resume.",
      "Do not mutate approved backlog items or the scope of any active task.",
      "Instead, identify a small set of useful draft backlog items or draft refinements that can move the project forward while execution is waiting.",
      "Prefer reviewable work that reduces risk, prepares follow-on execution, or addresses likely unblockers.",
      "Use Smithly MCP tools to record the drafted work and explain briefly why each item helps.",
    ].join(" "),
    title: "Idle backlog generation",
    trigger: "blocked_or_waiting",
  },
  {
    enabled: true,
    id: "loop-security-audit",
    kind: "security_audit",
    prompt: [
      "Run the default security-audit loop for this project.",
      "Review the full codebase for concrete security weaknesses, insecure defaults, secrets handling risks, authorization gaps, dependency exposure, and unsafe operational assumptions.",
      "Do not mutate approved backlog items or the scope of any active task.",
      "Draft a small set of human-reviewed backlog items for the highest-value security follow-ups you find.",
      "Each draft should explain the risk, the likely impact, and the smallest pragmatic remediation slice.",
      "Use Smithly MCP tools to record the backlog items with human review mode.",
    ].join(" "),
    title: "Security audit",
    trigger: "idle",
  },
  {
    enabled: true,
    id: "loop-best-practices-2026",
    kind: "best_practices",
    prompt: [
      "Run the default pragmatic 2026 best-practices loop for this project.",
      "Review the current codebase against pragmatic 2026 engineering practices, including maintainability, testing depth, developer ergonomics, operational resilience, dependency hygiene, and workflow clarity.",
      "Do not mutate approved backlog items or the scope of any active task.",
      "Draft a small set of human-reviewed backlog items for the highest-leverage improvements you find.",
      "Each draft should explain the current gap, the practical benefit of fixing it in 2026, and the smallest useful implementation slice.",
      "Use Smithly MCP tools to record the backlog items with human review mode.",
    ].join(" "),
    title: "Pragmatic 2026 best practices",
    trigger: "idle",
  },
];

interface DesktopPlanningSession {
  readonly workerSessionId: string;
  readonly terminalKey: string;
  readonly status: string;
}

interface DesktopBootstrapSession {
  readonly cwd: string;
  readonly messages: readonly DesktopChatMessage[];
  readonly status: string;
  readonly terminalKey: string;
}

interface DesktopCodexSession {
  readonly backlogItemId: string;
  readonly backlogItemTitle: string;
  readonly status: string;
  readonly taskRunId: string;
  readonly terminalKey: string;
  readonly workerSessionId: string;
}

interface PlanningOutputEvent {
  readonly terminalKey: string;
  readonly rawData: string;
  readonly entries: readonly DesktopChatMessage[];
  readonly storageUpdated: boolean;
}

interface CodexOutputEvent {
  readonly terminalKey: string;
  readonly rawData: string;
}

interface DesktopUiStateSnapshot {
  readonly activePlanningPaneKey?: string;
  readonly activeCodexTaskRunId?: string;
  readonly isFocusPaneMinified?: boolean;
  readonly isCodingVisible?: boolean;
  readonly isOrchestrationVisible?: boolean;
  readonly isProjectWorkspaceOpen?: boolean;
  readonly openCodexTaskRunIds?: readonly string[];
  readonly openPlanningPaneKeys?: readonly string[];
  readonly selectedBacklogItemId?: string;
  readonly selectedProjectId?: string;
}

interface SmithlyDesktopApi {
  getStatus(): Promise<DesktopStatus>;
  getSavedUiState(): Promise<DesktopUiStateSnapshot>;
  registerProject(input: DesktopProjectRegistrationInput): Promise<DesktopStatus>;
  saveUiState(state: DesktopUiStateSnapshot): Promise<void>;
  selectProject(projectId: string): Promise<DesktopStatus>;
  selectBacklogItem(backlogItemId: string): Promise<DesktopStatus>;
  setProjectStatus(projectId: string, status: "paused" | "archived"): Promise<DesktopStatus>;
  playProject(projectId: string): Promise<DesktopStatus>;
  pauseProject(projectId: string): Promise<DesktopStatus>;
  ensureBootstrapSession(): Promise<DesktopStatus>;
  updateProject(
    input: DesktopProjectRegistrationInput & { projectId: string },
  ): Promise<DesktopStatus>;
  updateReviewRun(
    reviewRunId: string,
    status: "approved" | "changes_requested",
    summaryText?: string,
  ): Promise<DesktopStatus>;
  deferReviewRun(reviewRunId: string, summaryText?: string): Promise<DesktopStatus>;
  commentOnReviewRun(reviewRunId: string, summaryText: string): Promise<DesktopStatus>;
  mergeTaskRun(taskRunId: string): Promise<DesktopStatus>;
  createMemoryNote(input: {
    noteType: "fact" | "decision" | "note" | "session_summary";
    title: string;
    bodyText: string;
    backlogItemId?: string;
  }): Promise<DesktopStatus>;
  ensurePlanningSession(scope: PlanningScope, backlogItemId?: string): Promise<DesktopStatus>;
  ensureCodexSession(taskRunId: string): Promise<DesktopStatus>;
  startCodexSession(backlogItemId: string, summaryText?: string): Promise<DesktopStatus>;
  submitPlanningInput(
    scope: PlanningScope,
    backlogItemId: string | undefined,
    bodyText: string,
  ): Promise<DesktopStatus>;
  writeCodexTerminal(terminalKey: string, data: string): Promise<void>;
  resizeCodexTerminal(terminalKey: string, cols: number, rows: number): Promise<void>;
  writePlanningTerminal(terminalKey: string, data: string): Promise<void>;
  resizePlanningTerminal(terminalKey: string, cols: number, rows: number): Promise<void>;
  onPlanningOutput(listener: (payload: PlanningOutputEvent) => void): () => void;
  onCodexOutput(listener: (payload: CodexOutputEvent) => void): () => void;
  onStatusUpdate(listener: (status: DesktopStatus) => void): () => void;
}

declare global {
  interface Window {
    smithlyDesktop: SmithlyDesktopApi;
  }
}

export {};

const appVersionNode = document.getElementById("app-version");
const themeNode = document.getElementById("theme-mode");
const dataDirectoryNode = document.getElementById("data-directory");
const projectCountNode = document.getElementById("project-count");
const dashboardPanelNode = document.getElementById("dashboard-panel");
const dashboardDigestNode = document.getElementById("dashboard-digest");
const projectListNode = document.getElementById("project-list");
const projectWorkspaceNode = document.getElementById("project-workspace");
const projectWorkspaceHeaderNode = document.getElementById("project-workspace-header");
const projectWorkspaceTitleNode = document.getElementById("project-workspace-title");
const focusShellNode = document.getElementById("focus-shell");
const focusMainNode = document.getElementById("focus-main");
const workspaceDetailsNode = document.getElementById("workspace-details");
const focusProjectListNode = document.getElementById("focus-project-list");
const closeProjectWorkspaceButton = document.getElementById(
  "close-project-workspace-button",
) as HTMLButtonElement | null;
const showOrchestrationButton = document.getElementById(
  "show-orchestration-button",
) as HTMLButtonElement | null;
const showCodingButton = document.getElementById("show-coding-button") as HTMLButtonElement | null;
const orchestrationShellNode = document.getElementById("orchestration-shell");
const codingShellNode = document.getElementById("coding-shell");
const hideOrchestrationButton = document.getElementById(
  "hide-orchestration-button",
) as HTMLButtonElement | null;
const hideCodingButton = document.getElementById("hide-coding-button") as HTMLButtonElement | null;
const projectCreatorModalNode = document.getElementById("project-creator-modal");
const projectCreatorTitleNode = document.getElementById("project-creator-title");
const openProjectCreatorButton = document.getElementById(
  "open-project-creator-button",
) as HTMLButtonElement | null;
const openManualProjectCreatorButton = document.getElementById(
  "open-manual-project-creator-button",
) as HTMLButtonElement | null;
const closeProjectCreatorButton = document.getElementById(
  "close-project-creator-button",
) as HTMLButtonElement | null;
const projectRegistrationForm = document.getElementById(
  "project-registration-form",
) as HTMLFormElement | null;
const projectRegistrationPathNode = document.getElementById(
  "project-registration-path",
) as HTMLInputElement | null;
const projectRegistrationNameNode = document.getElementById(
  "project-registration-name",
) as HTMLInputElement | null;
const projectRegistrationVerificationNode = document.getElementById(
  "project-registration-verification",
) as HTMLTextAreaElement | null;
const projectRegistrationMetadataNode = document.getElementById(
  "project-registration-metadata",
) as HTMLTextAreaElement | null;
const projectRegistrationApprovalNewBacklogNode = document.getElementById(
  "project-registration-approval-new-backlog",
) as HTMLInputElement | null;
const projectRegistrationApprovalScopeNode = document.getElementById(
  "project-registration-approval-scope",
) as HTMLInputElement | null;
const projectRegistrationApprovalHighRiskNode = document.getElementById(
  "project-registration-approval-high-risk",
) as HTMLInputElement | null;
const projectPlanningLoopListNode = document.getElementById("project-planning-loop-list");
const addProjectPlanningLoopButton = document.getElementById(
  "add-project-planning-loop-button",
) as HTMLButtonElement | null;
const projectRegistrationStatusNode = document.getElementById("project-registration-status");
const memoryPanelNode = document.getElementById("memory-list");
const memoryComposerModalNode = document.getElementById("memory-composer-modal");
const openMemoryComposerButton = document.getElementById(
  "open-memory-composer-button",
) as HTMLButtonElement | null;
const closeMemoryComposerButton = document.getElementById(
  "close-memory-composer-button",
) as HTMLButtonElement | null;
const memoryComposerForm = document.getElementById(
  "memory-composer-form",
) as HTMLFormElement | null;
const memoryComposerTypeNode = document.getElementById(
  "memory-composer-type",
) as HTMLSelectElement | null;
const memoryComposerTitleNode = document.getElementById(
  "memory-composer-title",
) as HTMLInputElement | null;
const memoryComposerBodyNode = document.getElementById(
  "memory-composer-body",
) as HTMLTextAreaElement | null;
const memoryComposerStatusNode = document.getElementById("memory-composer-status");
const backlogListNode = document.getElementById("backlog-list");
const taskListNode = document.getElementById("task-list");
const approvalsListNode = document.getElementById("approvals-list");
const blockersListNode = document.getElementById("blockers-list");
const eventLogNode = document.getElementById("event-log");
const terminalNode = document.getElementById("terminal");
const terminalCaptionNode = document.getElementById("terminal-caption");
const shellStatusNode = document.getElementById("shell-status");
const projectDetailTitleNode = document.getElementById("project-detail-title");
const planningPaneTabsNode = document.getElementById("planning-pane-tabs");
const codingPaneTabsNode = document.getElementById("coding-pane-tabs");
const planningTitleNode = document.getElementById("planning-title");
const planningStatusNode = document.getElementById("planning-status");
const planningHistoryNode = document.getElementById("planning-history");
const codingStatusNode = document.getElementById("coding-status");
const codingCaptionNode = document.getElementById("coding-caption");
const projectPlanningButton = document.getElementById(
  "project-planning-button",
) as HTMLButtonElement | null;
const projectEditButton = document.getElementById(
  "project-edit-button",
) as HTMLButtonElement | null;
const projectArchiveButton = document.getElementById(
  "project-archive-button",
) as HTMLButtonElement | null;
const projectPlayButton = document.getElementById(
  "project-play-button",
) as HTMLButtonElement | null;
const projectPauseButton = document.getElementById(
  "project-pause-button",
) as HTMLButtonElement | null;
const projectReactivateButton = document.getElementById(
  "project-reactivate-button",
) as HTMLButtonElement | null;
const taskPlanningButton = document.getElementById(
  "task-planning-button",
) as HTMLButtonElement | null;
const selectedBacklogTitleNode = document.getElementById("selected-backlog-title");
const selectedBacklogStatusNode = document.getElementById("selected-backlog-status");
const selectedBacklogMetaNode = document.getElementById("selected-backlog-meta");
const selectedBacklogScopeNode = document.getElementById("selected-backlog-scope");
const selectedBacklogCriteriaNode = document.getElementById("selected-backlog-criteria");
const selectedBacklogReviewActionsNode = document.getElementById("selected-backlog-review-actions");
const selectedBacklogReviewHistoryNode = document.getElementById("selected-backlog-review-history");
const selectedBacklogVerificationHistoryNode = document.getElementById(
  "selected-backlog-verification-history",
);
const codexTerminalNode = document.getElementById("codex-terminal");

let currentStatus: DesktopStatus | null = null;
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let currentTerminalSignature = "";
let codexTerminal: Terminal | null = null;
let codexFitAddon: FitAddon | null = null;
let currentCodexTerminalSignature = "";
let editingProjectId: string | null = null;
let projectPlanningLoopDrafts: DesktopPlanningLoop[] = clonePlanningLoops(
  DEFAULT_PROJECT_PLANNING_LOOPS,
);
let activePlanningPaneKey: SessionPaneKey | null = null;
let openPlanningPaneKeys: SessionPaneKey[] = [];
let activeCodexTaskRunId: string | null = null;
let openCodexTaskRunIds: string[] = [];
let isProjectWorkspaceOpen = false;
let isOrchestrationVisible = false;
let isCodingVisible = false;
let isFocusPaneMinified = false;
const terminalBuffers = new Map<string, string[]>();
const codexTerminalBuffers = new Map<string, string[]>();
let terminalResizeObserver: ResizeObserver | null = null;
let codexTerminalResizeObserver: ResizeObserver | null = null;

window.smithlyDesktop.onPlanningOutput((payload) => {
  const chunks = terminalBuffers.get(payload.terminalKey) ?? [];

  chunks.push(payload.rawData);
  terminalBuffers.set(payload.terminalKey, chunks.slice(-500));

  const activeSession = getActivePlanningSession(currentStatus, activePlanningPaneKey);

  if (activeSession?.terminalKey === payload.terminalKey) {
    terminal?.write(payload.rawData);
  }

  if (payload.storageUpdated) {
    void pollStatus(2, 150);
  }
});

window.smithlyDesktop.onCodexOutput((payload) => {
  const chunks = codexTerminalBuffers.get(payload.terminalKey) ?? [];

  chunks.push(payload.rawData);
  codexTerminalBuffers.set(payload.terminalKey, chunks.slice(-500));

  const activeSession = getActiveCodexSession(currentStatus, activeCodexTaskRunId);

  if (activeSession?.terminalKey === payload.terminalKey) {
    codexTerminal?.write(payload.rawData);
  }

  void pollStatus(2, 150);
});

window.smithlyDesktop.onStatusUpdate((status) => {
  renderDesktopStatus(status);
});

function setNodeText(node: HTMLElement | null, text: string): void {
  if (node === null) {
    return;
  }

  node.textContent = text;
}

function renderProjects(status: DesktopStatus): void {
  if (projectListNode === null) {
    return;
  }

  projectListNode.innerHTML = "";

  for (const project of status.projects) {
    const article = document.createElement("article");
    article.className = "project-card";
    article.dataset.selected = String(status.selectedProjectId === project.id);
    article.innerHTML = `
      <header class="project-card__header">
        <div>
          <h3>${escapeHtml(project.name)}</h3>
          <p>${escapeHtml(project.repoPath)}</p>
          <p class="project-card__meta">Lifecycle: ${escapeHtml(project.status)}</p>
          <p class="project-card__meta">Verification: ${escapeHtml(project.verificationSummary)}</p>
          <p class="project-card__meta">Approval: ${escapeHtml(project.approvalPolicySummary)}</p>
          <p class="project-card__meta">Metadata: ${escapeHtml(project.metadataSummary)}</p>
        </div>
        <span class="project-status" data-status="${escapeHtml(project.mode)}">${escapeHtml(project.mode)}</span>
      </header>
      <dl class="project-metrics">
        <div>
          <dt>Mode</dt>
          <dd>${escapeHtml(project.mode)}</dd>
        </div>
        <div>
          <dt>Active Sessions</dt>
          <dd>${project.activeSessionCount}</dd>
        </div>
        <div>
          <dt>Backlog Items</dt>
          <dd>${project.backlogCount}</dd>
        </div>
      </dl>
      <div class="project-card__actions">
        <button type="button" data-project-action="play" data-project-control-id="${escapeHtml(project.id)}" ${
          project.status === "archived" || project.status === "active" ? "disabled" : ""
        }>
          Play
        </button>
        <button type="button" data-project-action="pause" data-project-control-id="${escapeHtml(project.id)}" ${
          project.status !== "active" ? "disabled" : ""
        }>
          Pause
        </button>
        <button type="button" data-project-id="${escapeHtml(project.id)}">Open Workspace</button>
      </div>
    `;
    article
      .querySelector('button[data-project-action="play"]')
      ?.addEventListener("click", async () => {
        renderDesktopStatus(await window.smithlyDesktop.playProject(project.id));
      });
    article
      .querySelector('button[data-project-action="pause"]')
      ?.addEventListener("click", async () => {
        renderDesktopStatus(await window.smithlyDesktop.pauseProject(project.id));
      });
    article.querySelector("button[data-project-id]")?.addEventListener("click", async () => {
      isProjectWorkspaceOpen = true;
      renderDesktopStatus(await window.smithlyDesktop.selectProject(project.id));
    });
    projectListNode.append(article);
  }
}

function renderFocusProjectList(status: DesktopStatus): void {
  if (focusProjectListNode === null) {
    return;
  }

  focusProjectListNode.innerHTML = "";

  for (const project of status.projects) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "focus-project-button";
    button.dataset.selected = String(status.selectedProjectId === project.id);
    button.innerHTML = `
      <strong>${escapeHtml(project.name)}</strong>
      <span>${escapeHtml(project.mode)}</span>
    `;
    button.addEventListener("click", async () => {
      isProjectWorkspaceOpen = true;
      renderDesktopStatus(await window.smithlyDesktop.selectProject(project.id));
    });
    focusProjectListNode.append(button);
  }
}

function renderDashboardDigest(status: DesktopStatus): void {
  if (dashboardDigestNode === null) {
    return;
  }

  if (status.projectCount === 0) {
    dashboardDigestNode.innerHTML =
      '<p class="empty-state">Register a project to see cross-project operator digests.</p>';
    return;
  }

  const sections: Array<{
    readonly description: string;
    readonly id: string;
    readonly items: readonly DesktopDashboardDigestItem[];
    readonly title: string;
  }> = [
    {
      description: "Recent changes across all managed projects.",
      id: "changed",
      items: status.dashboardDigest.changed,
      title: "What Changed",
    },
    {
      description: "Projects blocked on approvals, dependencies, or credits.",
      id: "waiting",
      items: status.dashboardDigest.waiting,
      title: "Waiting",
    },
    {
      description: "Projects currently executing hidden work.",
      id: "running",
      items: status.dashboardDigest.running,
      title: "Running",
    },
    {
      description: "The next runnable approved work across projects.",
      id: "next",
      items: status.dashboardDigest.next,
      title: "Next",
    },
    {
      description: "Draft work and approvals currently proposed by AI.",
      id: "ai-proposed",
      items: status.dashboardDigest.aiProposed,
      title: "AI Proposed",
    },
  ];

  dashboardDigestNode.innerHTML = `
    <div id="dashboard-digest-summary" class="dashboard-digest__summary">
      ${renderDashboardDigestMetric("Active Projects", status.dashboardDigest.summary.activeProjects)}
      ${renderDashboardDigestMetric("Waiting Projects", status.dashboardDigest.summary.waitingProjects)}
      ${renderDashboardDigestMetric("Running Tasks", status.dashboardDigest.summary.runningTasks)}
      ${renderDashboardDigestMetric("Ready Projects", status.dashboardDigest.summary.readyProjects)}
      ${renderDashboardDigestMetric("Paused Projects", status.dashboardDigest.summary.pausedProjects)}
      ${renderDashboardDigestMetric("Archived Projects", status.dashboardDigest.summary.archivedProjects)}
    </div>
    <div class="dashboard-digest__sections">
      ${sections
        .map((section) => {
          return `
            <section id="dashboard-digest-${section.id}" class="dashboard-digest__section">
              <header>
                <h3>${escapeHtml(section.title)}</h3>
                <p>${escapeHtml(section.description)}</p>
              </header>
              <div class="dashboard-digest__items">
                ${renderDashboardDigestItems(section.items)}
              </div>
            </section>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderDashboardDigestMetric(label: string, value: number): string {
  return `
    <dl class="dashboard-digest__metric">
      <dt>${escapeHtml(label)}</dt>
      <dd>${value}</dd>
    </dl>
  `;
}

function renderDashboardDigestItems(items: readonly DesktopDashboardDigestItem[]): string {
  if (items.length === 0) {
    return '<p class="empty-state">Nothing to report right now.</p>';
  }

  return items
    .map((item) => {
      return `
        <article class="list-card" data-dashboard-digest-item="${escapeHtml(item.id)}">
          <div class="dashboard-digest__item-header">
            <strong>${escapeHtml(item.title)}</strong>
            <span class="list-status">${escapeHtml(item.status)}</span>
          </div>
          <p class="dashboard-digest__item-project">${escapeHtml(item.projectName)}</p>
          <p>${escapeHtml(item.detail)}</p>
          <time>${escapeHtml(item.timestamp)}</time>
        </article>
      `;
    })
    .join("");
}

function createSessionPaneKey(scope: PlanningScope, backlogItemId?: string): SessionPaneKey {
  if (scope === "project") {
    return `project:${currentStatus?.selectedProjectId ?? "missing"}`;
  }

  return `task:${backlogItemId ?? "missing"}`;
}

function createBootstrapPaneKey(): SessionPaneKey {
  return "bootstrap";
}

function renderProjectRegistrationStatus(message: string): void {
  setNodeText(projectRegistrationStatusNode, message);
}

function setProjectCreatorModalOpen(isOpen: boolean): void {
  projectCreatorModalNode?.toggleAttribute("hidden", !isOpen);
}

function setMemoryComposerModalOpen(isOpen: boolean): void {
  memoryComposerModalNode?.toggleAttribute("hidden", !isOpen);
}

function clonePlanningLoops(loops: readonly DesktopPlanningLoop[]): DesktopPlanningLoop[] {
  return loops.map((planningLoop) => ({ ...planningLoop }));
}

function renderPlanningLoopEditor(): void {
  if (projectPlanningLoopListNode === null) {
    return;
  }

  projectPlanningLoopListNode.innerHTML = projectPlanningLoopDrafts
    .map((planningLoop, index) => {
      const moveUpDisabled = index === 0 ? "disabled" : "";
      const moveDownDisabled = index === projectPlanningLoopDrafts.length - 1 ? "disabled" : "";
      const deleteButton =
        planningLoop.kind === "custom"
          ? `<button type="button" data-loop-action="delete" data-loop-id="${escapeHtml(planningLoop.id)}">Delete</button>`
          : "";

      return `
        <article class="project-loop-card" data-loop-card data-loop-id="${escapeHtml(planningLoop.id)}">
          <div class="project-loop-card__header">
            <label>
              <input type="checkbox" data-loop-field="enabled" data-loop-id="${escapeHtml(planningLoop.id)}" ${
                planningLoop.enabled ? "checked" : ""
              } />
              Enabled
            </label>
            <div class="project-loop-card__actions">
              <button type="button" data-loop-action="move-up" data-loop-id="${escapeHtml(planningLoop.id)}" ${moveUpDisabled}>Up</button>
              <button type="button" data-loop-action="move-down" data-loop-id="${escapeHtml(planningLoop.id)}" ${moveDownDisabled}>Down</button>
              ${deleteButton}
            </div>
          </div>
          <label>
            Loop title
            <input type="text" data-loop-field="title" data-loop-id="${escapeHtml(planningLoop.id)}" value="${escapeHtml(planningLoop.title)}" />
          </label>
          <label>
            Trigger
            <select data-loop-field="trigger" data-loop-id="${escapeHtml(planningLoop.id)}">
              <option value="idle" ${planningLoop.trigger === "idle" ? "selected" : ""}>Idle project</option>
              <option value="blocked_or_waiting" ${
                planningLoop.trigger === "blocked_or_waiting" ? "selected" : ""
              }>Blocked or waiting</option>
            </select>
          </label>
          <label>
            Prompt
            <textarea rows="4" data-loop-field="prompt" data-loop-id="${escapeHtml(planningLoop.id)}">${escapeHtml(planningLoop.prompt)}</textarea>
          </label>
        </article>
      `;
    })
    .join("");

  projectPlanningLoopListNode
    .querySelectorAll<HTMLInputElement>('input[data-loop-field="enabled"]')
    .forEach((node) => {
      node.addEventListener("change", () => {
        updatePlanningLoopDraft(node.dataset.loopId ?? "", {
          enabled: node.checked,
        });
      });
    });
  projectPlanningLoopListNode
    .querySelectorAll<HTMLInputElement>('input[data-loop-field="title"]')
    .forEach((node) => {
      node.addEventListener("input", () => {
        updatePlanningLoopDraft(node.dataset.loopId ?? "", {
          title: node.value,
        });
      });
    });
  projectPlanningLoopListNode
    .querySelectorAll<HTMLSelectElement>('select[data-loop-field="trigger"]')
    .forEach((node) => {
      node.addEventListener("change", () => {
        updatePlanningLoopDraft(node.dataset.loopId ?? "", {
          trigger: node.value as DesktopPlanningLoop["trigger"],
        });
      });
    });
  projectPlanningLoopListNode
    .querySelectorAll<HTMLTextAreaElement>('textarea[data-loop-field="prompt"]')
    .forEach((node) => {
      node.addEventListener("input", () => {
        updatePlanningLoopDraft(node.dataset.loopId ?? "", {
          prompt: node.value,
        });
      });
    });
  projectPlanningLoopListNode.querySelectorAll<HTMLButtonElement>("button[data-loop-action]").forEach(
    (node) => {
      node.addEventListener("click", () => {
        const loopId = node.dataset.loopId ?? "";

        switch (node.dataset.loopAction) {
          case "move-up":
            reorderPlanningLoopDraft(loopId, -1);
            break;
          case "move-down":
            reorderPlanningLoopDraft(loopId, 1);
            break;
          case "delete":
            deletePlanningLoopDraft(loopId);
            break;
          default:
            break;
        }
      });
    },
  );
}

function updatePlanningLoopDraft(
  loopId: string,
  patch: Partial<Pick<DesktopPlanningLoop, "enabled" | "prompt" | "title" | "trigger">>,
): void {
  projectPlanningLoopDrafts = projectPlanningLoopDrafts.map((planningLoop) => {
    return planningLoop.id === loopId ? { ...planningLoop, ...patch } : planningLoop;
  });
}

function reorderPlanningLoopDraft(loopId: string, direction: -1 | 1): void {
  const loopIndex = projectPlanningLoopDrafts.findIndex((planningLoop) => planningLoop.id === loopId);

  if (loopIndex < 0) {
    return;
  }

  const nextIndex = loopIndex + direction;

  if (nextIndex < 0 || nextIndex >= projectPlanningLoopDrafts.length) {
    return;
  }

  const reorderedLoops = [...projectPlanningLoopDrafts];
  const [planningLoop] = reorderedLoops.splice(loopIndex, 1);

  reorderedLoops.splice(nextIndex, 0, planningLoop!);
  projectPlanningLoopDrafts = reorderedLoops;
  renderPlanningLoopEditor();
}

function deletePlanningLoopDraft(loopId: string): void {
  projectPlanningLoopDrafts = projectPlanningLoopDrafts.filter((planningLoop) => {
    return planningLoop.id !== loopId || planningLoop.kind !== "custom";
  });
  renderPlanningLoopEditor();
}

function resetProjectRegistrationForm(): void {
  editingProjectId = null;

  if (projectRegistrationPathNode !== null) {
    projectRegistrationPathNode.value = "";
  }

  if (projectRegistrationNameNode !== null) {
    projectRegistrationNameNode.value = "";
  }

  if (projectRegistrationVerificationNode !== null) {
    projectRegistrationVerificationNode.value = "";
  }

  if (projectRegistrationMetadataNode !== null) {
    projectRegistrationMetadataNode.value = "";
  }

  if (projectRegistrationApprovalNewBacklogNode !== null) {
    projectRegistrationApprovalNewBacklogNode.checked = true;
  }

  if (projectRegistrationApprovalScopeNode !== null) {
    projectRegistrationApprovalScopeNode.checked = true;
  }

  if (projectRegistrationApprovalHighRiskNode !== null) {
    projectRegistrationApprovalHighRiskNode.checked = true;
  }

  projectPlanningLoopDrafts = clonePlanningLoops(DEFAULT_PROJECT_PLANNING_LOOPS);
  renderPlanningLoopEditor();
  setNodeText(projectCreatorTitleNode, "Create project");
  renderProjectRegistrationStatus("");
}

function resetMemoryComposerForm(): void {
  if (memoryComposerTypeNode !== null) {
    memoryComposerTypeNode.value = "note";
  }

  if (memoryComposerTitleNode !== null) {
    memoryComposerTitleNode.value = "";
  }

  if (memoryComposerBodyNode !== null) {
    memoryComposerBodyNode.value = "";
  }

  setNodeText(memoryComposerStatusNode, "");
}

function openProjectCreatorModal(mode: "create" | "edit"): void {
  if (mode === "create") {
    resetProjectRegistrationForm();
  } else {
    setNodeText(projectCreatorTitleNode, "Edit project");
  }

  setProjectCreatorModalOpen(true);
  projectRegistrationPathNode?.focus();
}

function renderMemoryNotes(memoryNotes: readonly DesktopMemoryNoteItem[]): void {
  if (memoryPanelNode === null) {
    return;
  }

  memoryPanelNode.innerHTML = "";

  if (memoryNotes.length === 0) {
    const emptyNode = document.createElement("p");
    emptyNode.className = "empty-state";
    emptyNode.textContent = "No project memory has been recorded yet.";
    memoryPanelNode.append(emptyNode);
    return;
  }

  for (const note of memoryNotes) {
    const article = document.createElement("article");
    article.className = "list-card";
    article.innerHTML = `
      <div class="list-card__row">
        <strong>${escapeHtml(note.title)}</strong>
        <span class="list-status">${escapeHtml(note.noteType)}</span>
      </div>
      <p>${escapeHtml(note.subtitle)}</p>
      <time>${escapeHtml(note.timestamp)}</time>
    `;
    memoryPanelNode.append(article);
  }
}

function renderList(
  node: HTMLElement | null,
  items: readonly DesktopListItem[],
  emptyLabel: string,
): void {
  if (node === null) {
    return;
  }

  node.innerHTML = "";

  if (items.length === 0) {
    const emptyNode = document.createElement("p");
    emptyNode.className = "empty-state";
    emptyNode.textContent = emptyLabel;
    node.append(emptyNode);
    return;
  }

  for (const item of items) {
    const element = document.createElement("article");
    element.className = "list-card";
    element.innerHTML = `
      <div class="list-card__row">
        <strong>${escapeHtml(item.title)}</strong>
        <span class="list-status">${escapeHtml(item.status)}</span>
      </div>
      <p>${escapeHtml(item.subtitle)}</p>
      <time>${escapeHtml(item.timestamp)}</time>
    `;
    node.append(element);
  }
}

function renderEvents(node: HTMLElement | null, events: readonly DesktopEventItem[]): void {
  if (node === null) {
    return;
  }

  node.innerHTML = "";

  for (const event of events) {
    const element = document.createElement("article");
    element.className = "event-item";
    element.innerHTML = `
      <strong>${escapeHtml(event.title)}</strong>
      <p>${escapeHtml(event.detail)}</p>
      <time>${escapeHtml(event.timestamp)}</time>
    `;
    node.append(element);
  }
}

function initTerminal(): void {
  if (terminalNode === null || terminal !== null) {
    return;
  }

  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"Iosevka Custom", "JetBrains Mono", monospace',
    fontSize: 13,
    scrollback: 100_000,
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalNode);
  fitAddon.fit();

  terminal.onData((data) => {
    const activeSession = getActivePlanningSession(currentStatus, activePlanningPaneKey);

    if (activeSession === undefined) {
      return;
    }

    void window.smithlyDesktop.writePlanningTerminal(activeSession.terminalKey, data);
  });

  terminalResizeObserver = new ResizeObserver(() => {
    fitAddon?.fit();
    const activeSession = getActivePlanningSession(currentStatus, activePlanningPaneKey);

    if (terminal === null || activeSession === undefined) {
      return;
    }

    void window.smithlyDesktop.resizePlanningTerminal(
      activeSession.terminalKey,
      terminal.cols,
      terminal.rows,
    );
  });
  terminalResizeObserver.observe(terminalNode);
}

function initCodexTerminal(): void {
  if (codexTerminalNode === null || codexTerminal !== null) {
    return;
  }

  codexTerminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"Iosevka Custom", "JetBrains Mono", monospace',
    fontSize: 13,
    scrollback: 100_000,
  });
  codexFitAddon = new FitAddon();
  codexTerminal.loadAddon(codexFitAddon);
  codexTerminal.open(codexTerminalNode);
  codexFitAddon.fit();

  codexTerminal.onData((data) => {
    const activeSession = getActiveCodexSession(currentStatus, activeCodexTaskRunId);

    if (activeSession === undefined) {
      return;
    }

    void window.smithlyDesktop.writeCodexTerminal(activeSession.terminalKey, data);
  });

  codexTerminalResizeObserver = new ResizeObserver(() => {
    codexFitAddon?.fit();
    const activeSession = getActiveCodexSession(currentStatus, activeCodexTaskRunId);

    if (codexTerminal === null || activeSession === undefined) {
      return;
    }

    void window.smithlyDesktop.resizeCodexTerminal(
      activeSession.terminalKey,
      codexTerminal.cols,
      codexTerminal.rows,
    );
  });
  codexTerminalResizeObserver.observe(codexTerminalNode);
}

function updateTerminalTheme(mode: "dark" | "light"): void {
  const theme =
    mode === "dark"
      ? {
          background: "#0f1724",
          black: "#0f1724",
          blue: "#66b9ff",
          brightBlack: "#516276",
          brightBlue: "#8ecfff",
          brightCyan: "#8fe7da",
          brightGreen: "#b5f38c",
          brightMagenta: "#f4a0ff",
          brightRed: "#ff9f9f",
          brightWhite: "#edf5ff",
          brightYellow: "#ffe58a",
          cursor: "#edf5ff",
          cyan: "#73d8c9",
          foreground: "#d6e3f1",
          green: "#9ddf72",
          magenta: "#df8cff",
          red: "#ff7b7b",
          selectionBackground: "#294063",
          white: "#d6e3f1",
          yellow: "#f3cf5a",
        }
      : {
          background: "#fbf8f2",
          black: "#243240",
          blue: "#1d5ea8",
          brightBlack: "#7f8b97",
          brightBlue: "#2a78d1",
          brightCyan: "#1d8b88",
          brightGreen: "#4f8c3d",
          brightMagenta: "#9b3bd0",
          brightRed: "#c84c4c",
          brightWhite: "#ffffff",
          brightYellow: "#a67410",
          cursor: "#243240",
          cyan: "#176f73",
          foreground: "#243240",
          green: "#3d7431",
          magenta: "#7c38ab",
          red: "#b14949",
          selectionBackground: "#cfe2f6",
          white: "#f7f9fb",
          yellow: "#8a620d",
        };

  if (terminal !== null) {
    terminal.options.theme = theme;
  }

  if (codexTerminal !== null) {
    codexTerminal.options.theme = theme;
  }
}

function renderWorkspaceVisibility(status: DesktopStatus): void {
  const hasSelectedProject = status.selectedProject !== undefined;
  const hasBootstrapSession = status.bootstrapSession !== undefined;
  const showWorkspace = isProjectWorkspaceOpen && (hasSelectedProject || hasBootstrapSession);
  const hasOpenChatRail =
    showWorkspace &&
    (hasBootstrapSession || openPlanningPaneKeys.length > 0 || openCodexTaskRunIds.length > 0);
  const showFocusMode = showWorkspace;
  const showOrchestration = showFocusMode && isOrchestrationVisible;
  const showCoding = showFocusMode && isCodingVisible;
  const showFocusMain = showFocusMode && (showOrchestration || showCoding) && !isFocusPaneMinified;
  const showWorkspaceDetails =
    showWorkspace &&
    !showOrchestration &&
    !showCoding &&
    !hasOpenChatRail;

  dashboardPanelNode?.toggleAttribute("hidden", showFocusMode);
  projectWorkspaceNode?.toggleAttribute("hidden", !showWorkspace);
  projectWorkspaceHeaderNode?.toggleAttribute("hidden", showFocusMode);
  focusShellNode?.toggleAttribute("hidden", !showFocusMode);
  focusMainNode?.toggleAttribute("hidden", !showFocusMain);
  workspaceDetailsNode?.toggleAttribute("hidden", !showWorkspaceDetails);
  orchestrationShellNode?.toggleAttribute("hidden", !showOrchestration);
  codingShellNode?.toggleAttribute("hidden", !showCoding);

  if (projectWorkspaceTitleNode !== null) {
    const selectedProjectName = status.projects.find(
      (project) => project.id === status.selectedProjectId,
    )?.name;
    projectWorkspaceTitleNode.textContent = selectedProjectName
      ? `Project workspace: ${selectedProjectName}`
      : hasBootstrapSession
        ? "Project bootstrap workspace"
        : "Project workspace";
  }

  if (showOrchestrationButton !== null) {
    showOrchestrationButton.disabled = !(hasSelectedProject || hasBootstrapSession);
  }

  if (showCodingButton !== null) {
    showCodingButton.disabled = !hasSelectedProject || activeCodexTaskRunId === null;
  }

  if (showOrchestration && showFocusMain) {
    window.requestAnimationFrame(() => {
      refitVisibleTerminal(status);
    });
  }

  if (showCoding && showFocusMain) {
    window.requestAnimationFrame(() => {
      refitVisibleCodexTerminal(status);
    });
  }
}

function renderPlanningPane(status: DesktopStatus): void {
  const activeThread = getActivePlanningThread(status, activePlanningPaneKey);
  const activeSession = getActivePlanningSession(status, activePlanningPaneKey);
  const activeScope = getPlanningScopeFromPaneKey(activePlanningPaneKey);
  const selectedBacklogItem = status.selectedProject?.selectedBacklogItem;
  const hasSelectedProject = status.selectedProject !== undefined;
  const hasBootstrapSession = status.bootstrapSession !== undefined;
  const selectedProjectSummary = status.projects.find(
    (project) => project.id === status.selectedProjectId,
  );

  renderPlanningPaneTabs(status);

  if (projectPlanningButton !== null) {
    projectPlanningButton.dataset.active = String(activeScope === "project");
    projectPlanningButton.disabled = !hasSelectedProject;
  }

  if (taskPlanningButton !== null) {
    taskPlanningButton.dataset.active = String(activeScope === "task");
    taskPlanningButton.disabled = selectedBacklogItem === undefined;
  }

  if (projectDetailTitleNode !== null) {
    projectDetailTitleNode.textContent = selectedProjectSummary
      ? `Project orchestration: ${selectedProjectSummary.name}`
      : hasBootstrapSession
        ? "Project bootstrap"
        : "Project orchestration";
  }

  if (projectEditButton !== null) {
    projectEditButton.disabled = !hasSelectedProject;
  }

  if (projectArchiveButton !== null) {
    projectArchiveButton.disabled = !hasSelectedProject;
  }

  if (projectPlayButton !== null) {
    projectPlayButton.disabled =
      !hasSelectedProject ||
      selectedProjectSummary?.status === "active" ||
      selectedProjectSummary?.status === "archived";
  }

  if (projectPauseButton !== null) {
    projectPauseButton.disabled = selectedProjectSummary?.status !== "active";
  }

  if (projectReactivateButton !== null) {
    projectReactivateButton.disabled = selectedProjectSummary?.status !== "archived";
  }

  setNodeText(planningTitleNode, activeThread?.title ?? "No planning thread");
  setNodeText(
    planningStatusNode,
    !hasSelectedProject && !hasBootstrapSession
      ? "Click Add Project to open a Claude bootstrap session, or use manual setup."
      : activePlanningPaneKey === "bootstrap"
        ? activeSession
          ? `bootstrap session ${activeSession.status} in ${status.bootstrapSession?.cwd ?? "~"}`
          : "bootstrap session idle"
        : activePlanningPaneKey === null
          ? hasBootstrapSession
            ? "Project bootstrap is available. Attach the Claude pane to continue shaping a new project."
            : describeProjectMode(selectedProjectSummary?.mode)
          : activeSession
            ? `${activeScope} planning session ${activeSession.status}`
            : `${activeScope} planning session idle`,
  );
  setNodeText(shellStatusNode, activeSession ? `${activeScope} TUI attached` : "Shell ready");
  setNodeText(
    terminalCaptionNode,
    !hasSelectedProject && !hasBootstrapSession
      ? "Add Project opens Claude in your home directory so you can talk through the new project first."
      : activePlanningPaneKey === "bootstrap"
        ? "Use Claude to discuss the idea, choose a name, pick a folder, and shape the first plan."
        : activeThread
          ? "Type directly into the attached Claude TUI when you need to interact."
          : "Open a Claude pane to attach a planning session.",
  );

  renderPlanningHistory(
    activePlanningPaneKey === "bootstrap"
      ? (status.bootstrapSession?.messages ?? [])
      : (activeThread?.messages ?? []),
  );
  renderSelectedBacklog(selectedBacklogItem);
  syncTerminalPane(status);
}

function describeProjectMode(mode: string | undefined): string {
  switch (mode) {
    case "actively executing":
      return "Project execution is running in the background. Attach a Claude pane to inspect it.";
    case "blocked on human":
      return "Project execution is waiting on human input or approval before work can continue.";
    case "blocked on external dependency":
      return "Project execution is blocked on an external dependency or system blocker.";
    case "waiting for credit":
      return "Project execution is waiting for credits before Smithly can continue.";
    case "ready to execute":
      return "Project has approved and ready work queued for execution.";
    case "planning":
      return "Project is in planning mode. Open a Claude pane to refine backlog work before execution.";
    case "paused":
    default:
      return "Project execution is paused. Click Play to start hidden orchestration or open a Claude pane manually.";
  }
}

function renderCodexPane(status: DesktopStatus): void {
  const selectedProject = status.selectedProject;
  const activeSession =
    activeCodexTaskRunId === null
      ? undefined
      : selectedProject?.codexSessions.find(
          (session) => session.taskRunId === activeCodexTaskRunId,
        );

  renderCodexPaneTabs(status);

  setNodeText(
    codingStatusNode,
    selectedProject === undefined
      ? "Select a project to attach Codex."
      : activeSession === undefined
        ? "Start a coding task to attach a Codex session."
        : `Codex task session ${activeSession.status}`,
  );
  setNodeText(
    codingCaptionNode,
    selectedProject === undefined
      ? "Select a project to enable Codex tasks."
      : activeSession === undefined
        ? "Start or reopen a Codex task session from Upcoming Work."
        : `Codex attached to ${activeSession.backlogItemTitle}.`,
  );
  syncCodexTerminalPane(status);
}

function renderCodexPaneTabs(status: DesktopStatus): void {
  if (codingPaneTabsNode === null) {
    return;
  }

  codingPaneTabsNode.innerHTML = "";

  if (openCodexTaskRunIds.length === 0) {
    const emptyNode = document.createElement("p");
    emptyNode.className = "empty-state";
    emptyNode.textContent = "No Codex task panes are open.";
    codingPaneTabsNode.append(emptyNode);
    return;
  }

  for (const taskRunId of openCodexTaskRunIds) {
    const session = status.selectedProject?.codexSessions.find(
      (candidate) => candidate.taskRunId === taskRunId,
    );
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-tab";
    button.dataset.active = String(activeCodexTaskRunId === taskRunId);
    button.innerHTML = `
      <span>${escapeHtml(session?.backlogItemTitle ?? taskRunId)}</span>
      <span>${escapeHtml(session?.status ?? "idle")}</span>
    `;
    button.addEventListener("click", () => {
      isFocusPaneMinified = false;
      isCodingVisible = true;
      isOrchestrationVisible = false;
      activeCodexTaskRunId = taskRunId;
      renderWorkspaceVisibility(currentStatus ?? status);
      renderCodexPane(currentStatus ?? status);
      void persistCurrentUiState();
    });

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "session-tab-close";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      closeCodexPane(taskRunId, status);
    });

    const wrapper = document.createElement("div");
    wrapper.className = "session-tab-row";
    wrapper.append(button, closeButton);
    codingPaneTabsNode.append(wrapper);
  }
}

function renderPlanningPaneTabs(status: DesktopStatus): void {
  if (planningPaneTabsNode === null) {
    return;
  }

  planningPaneTabsNode.innerHTML = "";

  if (openPlanningPaneKeys.length === 0) {
    const emptyNode = document.createElement("p");
    emptyNode.className = "empty-state";
    emptyNode.textContent = "No Claude panes are open.";
    planningPaneTabsNode.append(emptyNode);
    return;
  }

  for (const paneKey of openPlanningPaneKeys) {
    const target = getPlanningTarget(status, paneKey);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-tab";
    button.dataset.active = String(activePlanningPaneKey === paneKey);
    button.innerHTML = `
      <span>${escapeHtml(getPlanningPaneLabel(status, paneKey))}</span>
      <span>${escapeHtml(target?.session?.status ?? "idle")}</span>
    `;
    button.addEventListener("click", async () => {
      const backlogItemId = getBacklogItemIdFromPaneKey(paneKey);

      if (backlogItemId !== undefined) {
        await focusBacklogItem(backlogItemId);
      }

      isFocusPaneMinified = false;
      isOrchestrationVisible = true;
      isCodingVisible = false;
      activePlanningPaneKey = paneKey;
      renderWorkspaceVisibility(currentStatus ?? status);
      renderPlanningPane(currentStatus ?? status);
      void persistCurrentUiState();
    });

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "session-tab-close";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      closePlanningPane(paneKey, status);
    });

    const wrapper = document.createElement("div");
    wrapper.className = "session-tab-row";
    wrapper.append(button, closeButton);
    planningPaneTabsNode.append(wrapper);
  }
}

function renderPlanningHistory(messages: readonly DesktopChatMessage[]): void {
  if (planningHistoryNode === null) {
    return;
  }

  planningHistoryNode.innerHTML = "";

  if (messages.length === 0) {
    const emptyNode = document.createElement("p");
    emptyNode.className = "empty-state";
    emptyNode.textContent = "No planning transcript has been recorded yet.";
    planningHistoryNode.append(emptyNode);
    return;
  }

  for (const message of messages) {
    const article = document.createElement("article");
    article.className = "chat-message";
    article.innerHTML = `
      <div class="chat-message__row">
        <strong>${escapeHtml(message.role)}</strong>
        <time>${escapeHtml(message.createdAt)}</time>
      </div>
      <p>${escapeHtml(message.bodyText)}</p>
    `;
    planningHistoryNode.append(article);
  }
}

function renderSelectedBacklog(backlogItem?: DesktopBacklogDetail): void {
  setNodeText(selectedBacklogTitleNode, backlogItem?.title ?? "No backlog item selected");
  setNodeText(selectedBacklogStatusNode, backlogItem?.status ?? "n/a");
  setNodeText(
    selectedBacklogMetaNode,
    backlogItem
      ? `priority ${backlogItem.priority} | ${backlogItem.riskLevel} risk | ${backlogItem.reviewMode} review${backlogItem.pullRequestStatus ? ` | ${backlogItem.pullRequestStatus}` : ""}`
      : "No backlog metadata selected",
  );
  setNodeText(
    selectedBacklogScopeNode,
    backlogItem?.scopeSummary ??
      "Project planning is active. Switch to task planning to focus one backlog item.",
  );

  if (selectedBacklogCriteriaNode !== null) {
    selectedBacklogCriteriaNode.innerHTML = "";

    if (backlogItem === undefined || backlogItem.acceptanceCriteria.length === 0) {
      const emptyNode = document.createElement("li");
      emptyNode.textContent = "No acceptance criteria recorded yet.";
      selectedBacklogCriteriaNode.append(emptyNode);
    } else {
      for (const criterion of backlogItem.acceptanceCriteria) {
        const item = document.createElement("li");
        item.textContent = criterion;
        selectedBacklogCriteriaNode.append(item);
      }
    }
  }

  renderBacklogReviewActions(backlogItem);
  renderHistoryList(
    selectedBacklogReviewHistoryNode,
    backlogItem?.reviewHistory ?? [],
    "No review history recorded yet.",
  );
  renderHistoryList(
    selectedBacklogVerificationHistoryNode,
    backlogItem?.verificationHistory ?? [],
    "No verification history recorded yet.",
  );
}

function renderBacklogReviewActions(backlogItem?: DesktopBacklogDetail): void {
  if (selectedBacklogReviewActionsNode === null) {
    return;
  }

  selectedBacklogReviewActionsNode.innerHTML = "";

  const pendingHumanReviewRunId = backlogItem?.actionableHumanReviewRunId;

  if (pendingHumanReviewRunId === undefined && backlogItem?.mergeTaskRunId === undefined) {
    return;
  }

  const summaryInput = document.createElement("textarea");
  summaryInput.rows = 3;
  summaryInput.placeholder = "Add an operator note for this review or merge decision.";
  summaryInput.className = "input";
  selectedBacklogReviewActionsNode.append(summaryInput);

  const actionRow = document.createElement("div");
  actionRow.className = "detail-actions";

  if (pendingHumanReviewRunId !== undefined) {
    const approveButton = document.createElement("button");
    approveButton.type = "button";
    approveButton.textContent = "Approve Review";
    approveButton.addEventListener("click", async () => {
      renderDesktopStatus(
        await window.smithlyDesktop.updateReviewRun(
          pendingHumanReviewRunId,
          "approved",
          summaryInput.value.trim() || "Operator approved the task.",
        ),
      );
    });

    const rejectButton = document.createElement("button");
    rejectButton.type = "button";
    rejectButton.textContent = "Reject Review";
    rejectButton.addEventListener("click", async () => {
      renderDesktopStatus(
        await window.smithlyDesktop.updateReviewRun(
          pendingHumanReviewRunId,
          "changes_requested",
          summaryInput.value.trim() || "Operator rejected the task.",
        ),
      );
    });

    const deferButton = document.createElement("button");
    deferButton.type = "button";
    deferButton.textContent = "Defer Review";
    deferButton.addEventListener("click", async () => {
      renderDesktopStatus(
        await window.smithlyDesktop.deferReviewRun(
          pendingHumanReviewRunId,
          summaryInput.value.trim() || "Operator deferred the review decision.",
        ),
      );
    });

    const commentButton = document.createElement("button");
    commentButton.type = "button";
    commentButton.textContent = "Add Comment";
    commentButton.addEventListener("click", async () => {
      const commentText = summaryInput.value.trim();

      if (commentText.length === 0) {
        return;
      }

      renderDesktopStatus(
        await window.smithlyDesktop.commentOnReviewRun(pendingHumanReviewRunId, commentText),
      );
    });

    actionRow.append(approveButton, rejectButton, deferButton, commentButton);
  }

  if (backlogItem?.mergeTaskRunId !== undefined) {
    const mergeButton = document.createElement("button");
    mergeButton.type = "button";
    mergeButton.textContent = "Merge Pull Request";
    mergeButton.addEventListener("click", async () => {
      renderDesktopStatus(await window.smithlyDesktop.mergeTaskRun(backlogItem.mergeTaskRunId!));
    });
    actionRow.append(mergeButton);
  }

  if (backlogItem?.pullRequestUrl !== undefined) {
    const pullRequestLink = document.createElement("a");
    pullRequestLink.href = backlogItem.pullRequestUrl;
    pullRequestLink.target = "_blank";
    pullRequestLink.rel = "noreferrer";
    pullRequestLink.textContent = "Open Pull Request";
    selectedBacklogReviewActionsNode.append(pullRequestLink);
  }

  selectedBacklogReviewActionsNode.append(actionRow);
}

function renderHistoryList(
  node: HTMLElement | null,
  items: readonly DesktopListItem[],
  emptyLabel: string,
): void {
  if (node === null) {
    return;
  }

  node.innerHTML = "";

  if (items.length === 0) {
    const emptyNode = document.createElement("p");
    emptyNode.className = "empty-state";
    emptyNode.textContent = emptyLabel;
    node.append(emptyNode);
    return;
  }

  for (const item of items) {
    const article = document.createElement("article");
    article.className = "list-card";
    article.innerHTML = `
      <div class="list-card__row">
        <strong>${escapeHtml(item.title)}</strong>
        <span class="list-status">${escapeHtml(item.status)}</span>
      </div>
      <p>${escapeHtml(item.subtitle)}</p>
      <time>${escapeHtml(item.timestamp)}</time>
    `;
    node.append(article);
  }
}

function syncTerminalPane(status: DesktopStatus): void {
  const activeScope = getPlanningScopeFromPaneKey(activePlanningPaneKey);
  const activeSession = getActivePlanningSession(status, activePlanningPaneKey);
  const signature = [
    activePlanningPaneKey ?? "none",
    activeSession?.terminalKey ?? "none",
    status.resolvedThemeMode,
  ].join(":");

  if (terminal === null || signature === currentTerminalSignature || !isOrchestrationVisible) {
    return;
  }

  currentTerminalSignature = signature;
  terminal.reset();
  terminal.focus();

  if (activeSession === undefined) {
    terminal.writeln(
      status.bootstrapSession === undefined && status.selectedProject === undefined
        ? "[smithly] Click Add Project to open a Claude bootstrap session."
        : "[smithly] Open a Claude pane to attach a planning session.",
    );
    return;
  }

  const buffer = terminalBuffers.get(activeSession.terminalKey) ?? [];

  if (buffer.length === 0) {
    terminal.writeln(`[smithly] ${activeScope ?? "planning"} terminal attached.`);
  } else {
    for (const chunk of buffer) {
      terminal.write(chunk);
    }
  }

  fitAddon?.fit();
  void window.smithlyDesktop.resizePlanningTerminal(
    activeSession.terminalKey,
    terminal.cols,
    terminal.rows,
  );
}

function syncCodexTerminalPane(status: DesktopStatus): void {
  const activeSession = getActiveCodexSession(status, activeCodexTaskRunId);
  const signature = [
    activeCodexTaskRunId ?? "none",
    activeSession?.terminalKey ?? "none",
    status.resolvedThemeMode,
  ].join(":");

  if (codexTerminal === null || signature === currentCodexTerminalSignature || !isCodingVisible) {
    return;
  }

  currentCodexTerminalSignature = signature;
  codexTerminal.reset();
  codexTerminal.focus();

  if (status.selectedProject === undefined) {
    codexTerminal.writeln("[smithly] Select a project to start Codex work.");
    return;
  }

  if (activeSession === undefined) {
    codexTerminal.writeln("[smithly] Start or reopen a Codex task session.");
    return;
  }

  const buffer = codexTerminalBuffers.get(activeSession.terminalKey) ?? [];

  if (buffer.length === 0) {
    codexTerminal.writeln(`[smithly] codex terminal attached for ${activeSession.taskRunId}.`);
  } else {
    for (const chunk of buffer) {
      codexTerminal.write(chunk);
    }
  }

  codexFitAddon?.fit();
  void window.smithlyDesktop.resizeCodexTerminal(
    activeSession.terminalKey,
    codexTerminal.cols,
    codexTerminal.rows,
  );
}

function refitVisibleTerminal(status: DesktopStatus): void {
  if (terminal === null || !isOrchestrationVisible) {
    return;
  }

  fitAddon?.fit();

  const activeSession = getActivePlanningSession(status, activePlanningPaneKey);

  if (activeSession === undefined) {
    return;
  }

  void window.smithlyDesktop.resizePlanningTerminal(
    activeSession.terminalKey,
    terminal.cols,
    terminal.rows,
  );
}

function refitVisibleCodexTerminal(status: DesktopStatus): void {
  if (codexTerminal === null || !isCodingVisible) {
    return;
  }

  codexFitAddon?.fit();

  const activeSession = getActiveCodexSession(status, activeCodexTaskRunId);

  if (activeSession === undefined) {
    return;
  }

  void window.smithlyDesktop.resizeCodexTerminal(
    activeSession.terminalKey,
    codexTerminal.cols,
    codexTerminal.rows,
  );
}

function applyTheme(mode: "dark" | "light"): void {
  document.documentElement.dataset.theme = mode;
}

function renderSelectedProject(status: DesktopStatus): void {
  const selectedProject = status.selectedProject;
  const completedWorkItems = [
    ...(selectedProject?.backlogItems ?? []).filter((item) =>
      ["done", "cancelled"].includes(item.status),
    ),
    ...(selectedProject?.taskRuns ?? []).filter((item) =>
      ["done", "cancelled"].includes(item.status),
    ),
  ];

  renderUpcomingWork(selectedProject);
  renderList(taskListNode, completedWorkItems, "No completed work has been recorded yet.");
  renderList(
    approvalsListNode,
    selectedProject?.approvals ?? [],
    "No approvals are waiting right now.",
  );
  renderList(blockersListNode, selectedProject?.blockers ?? [], "No blockers are open right now.");
  renderMemoryNotes(selectedProject?.memoryNotes ?? []);
  renderEvents(eventLogNode, selectedProject?.events ?? []);
  renderPlanningPane(status);
  renderCodexPane(status);
}

function renderError(message: string): void {
  setNodeText(appVersionNode, "Unavailable");
  setNodeText(themeNode, "Unavailable");
  setNodeText(dataDirectoryNode, "Unavailable");
  setNodeText(projectCountNode, "Unavailable");
  setNodeText(shellStatusNode, message);
}

function renderDesktopStatus(status: DesktopStatus): void {
  reconcileBootstrapWorkspaceState(status);
  currentStatus = status;
  applyTheme(status.resolvedThemeMode);
  updateTerminalTheme(status.resolvedThemeMode);
  setNodeText(appVersionNode, status.appVersion);
  setNodeText(themeNode, `${status.themePreference} -> ${status.resolvedThemeMode}`);
  setNodeText(dataDirectoryNode, status.dataDirectory);
  setNodeText(projectCountNode, String(status.projectCount));
  renderDashboardDigest(status);
  renderProjects(status);
  renderFocusProjectList(status);
  renderWorkspaceVisibility(status);
  renderSelectedProject(status);
  setNodeText(shellStatusNode, "Shell ready");
  void persistUiState(status);
}

async function activatePlanningScope(scope: PlanningScope): Promise<void> {
  if (currentStatus?.selectedProject === undefined) {
    return;
  }

  const backlogItemId =
    scope === "task" ? currentStatus.selectedProject.selectedBacklogItem?.id : undefined;

  await openPlanningPane(scope, backlogItemId);
}

function renderPlanningPending(scope: PlanningPaneScope): void {
  setNodeText(shellStatusNode, `Connecting ${scope} planning session...`);
}

async function pollStatus(rounds: number, delayMs: number): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await delay(delayMs);
    renderDesktopStatus(await window.smithlyDesktop.getStatus());
  }
}

function getActivePlanningThread(
  status: DesktopStatus | null,
  paneKey: SessionPaneKey | null,
): DesktopChatThread | undefined {
  const target = getPlanningTarget(status, paneKey);

  if (target === undefined) {
    return undefined;
  }

  return target.thread;
}

function getActivePlanningSession(
  status: DesktopStatus | null,
  paneKey: SessionPaneKey | null,
): DesktopPlanningSession | undefined {
  const target = getPlanningTarget(status, paneKey);

  if (target === undefined) {
    return undefined;
  }

  return target.session;
}

function getActiveCodexSession(
  status: DesktopStatus | null,
  taskRunId: string | null,
): DesktopCodexSession | undefined {
  if (status?.selectedProject === undefined || taskRunId === null) {
    return undefined;
  }

  return status.selectedProject.codexSessions.find((session) => session.taskRunId === taskRunId);
}

function getBootstrapHandoffProject(status: DesktopStatus): DesktopProjectSummary | undefined {
  return status.projects.find((project) => {
    return (
      project.id === status.selectedProjectId &&
      project.metadataEntries.bootstrapState === "ready_for_dashboard"
    );
  });
}

function reconcileBootstrapWorkspaceState(status: DesktopStatus): void {
  const handoffProject = getBootstrapHandoffProject(status);

  if (handoffProject === undefined || !openPlanningPaneKeys.includes("bootstrap")) {
    return;
  }

  const projectPaneKey = `project:${handoffProject.id}` as SessionPaneKey;

  openPlanningPaneKeys = openPlanningPaneKeys.map((paneKey) => {
    return paneKey === "bootstrap" ? projectPaneKey : paneKey;
  });
  openPlanningPaneKeys = [...new Set(openPlanningPaneKeys)] as SessionPaneKey[];

  if (activePlanningPaneKey === "bootstrap") {
    activePlanningPaneKey = projectPaneKey;
    currentTerminalSignature = "";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

projectRegistrationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (projectRegistrationPathNode === null) {
    return;
  }

  const repoPath = projectRegistrationPathNode.value.trim();
  const projectName = projectRegistrationNameNode?.value.trim() ?? "";
  const verificationCommands = parseMultilineList(projectRegistrationVerificationNode?.value ?? "");
  const metadata = parseMetadataEntries(projectRegistrationMetadataNode?.value ?? "");
  const planningLoops = projectPlanningLoopDrafts.map((planningLoop) => ({
    ...planningLoop,
    prompt: planningLoop.prompt.trim(),
    title: planningLoop.title.trim(),
  }));

  if (repoPath.length === 0) {
    renderProjectRegistrationStatus("Local repo path is required.");
    return;
  }

  if (planningLoops.some((planningLoop) => planningLoop.title.length === 0)) {
    renderProjectRegistrationStatus("Each backlog-generation loop needs a title.");
    return;
  }

  if (planningLoops.some((planningLoop) => planningLoop.prompt.length === 0)) {
    renderProjectRegistrationStatus("Each backlog-generation loop needs a prompt.");
    return;
  }

  renderProjectRegistrationStatus(
    editingProjectId === null ? "Registering local project..." : "Updating project...",
  );

  try {
    const previousStatus = currentStatus;
    const projectInput = {
      approvalPolicy: {
        requireApprovalForHighRiskTasks: projectRegistrationApprovalHighRiskNode?.checked ?? true,
        requireApprovalForNewBacklogItems:
          projectRegistrationApprovalNewBacklogNode?.checked ?? true,
        requireApprovalForScopeChanges: projectRegistrationApprovalScopeNode?.checked ?? true,
      },
      metadata,
      ...(projectName.length > 0 ? { name: projectName } : {}),
      planningLoops,
      repoPath,
      verificationCommands,
    } satisfies DesktopProjectRegistrationInput;
    const status =
      editingProjectId === null
        ? await window.smithlyDesktop.registerProject(projectInput)
        : await window.smithlyDesktop.updateProject({
            ...projectInput,
            projectId: editingProjectId,
          });

    renderDesktopStatus(status);
    renderProjectRegistrationStatus(
      editingProjectId === null
        ? `Registered ${status.projects[status.projects.length - 1]?.name ?? "project"}.`
        : `Updated ${status.projects.find((project) => project.id === editingProjectId)?.name ?? "project"}.`,
    );
    setProjectCreatorModalOpen(false);
    resetProjectRegistrationForm();

    if (previousStatus?.selectedProject === undefined && status.selectedProject !== undefined) {
      activePlanningPaneKey = null;
      openPlanningPaneKeys = [];
    }
  } catch (error: unknown) {
    renderProjectRegistrationStatus(error instanceof Error ? error.message : String(error));
  }
});

addProjectPlanningLoopButton?.addEventListener("click", () => {
  projectPlanningLoopDrafts = [
    ...projectPlanningLoopDrafts,
    {
      enabled: true,
      id: `loop-custom-${window.crypto.randomUUID()}`,
      kind: "custom",
      prompt:
        "Run this custom backlog-generation loop for the project. Review the codebase and draft human-reviewed backlog items for the selected theme.",
      title: "Custom loop",
      trigger: "idle",
    },
  ];
  renderPlanningLoopEditor();
});

projectEditButton?.addEventListener("click", () => {
  const selectedProjectId = currentStatus?.selectedProjectId;
  const selectedProject =
    selectedProjectId === undefined
      ? undefined
      : currentStatus?.projects.find((project) => project.id === selectedProjectId);

  if (
    selectedProject === undefined ||
    projectRegistrationPathNode === null ||
    projectRegistrationVerificationNode === null ||
    projectRegistrationMetadataNode === null
  ) {
    return;
  }

  editingProjectId = selectedProject.id;
  setNodeText(projectCreatorTitleNode, "Edit project");
  projectRegistrationPathNode.value = selectedProject.repoPath;

  if (projectRegistrationNameNode !== null) {
    projectRegistrationNameNode.value = selectedProject.name;
  }

  projectRegistrationVerificationNode.value = selectedProject.verificationCommands.join("\n");
  projectRegistrationMetadataNode.value = Object.entries(selectedProject.metadataEntries)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  if (projectRegistrationApprovalNewBacklogNode !== null) {
    projectRegistrationApprovalNewBacklogNode.checked =
      selectedProject.approvalPolicy.requireApprovalForNewBacklogItems;
  }

  if (projectRegistrationApprovalScopeNode !== null) {
    projectRegistrationApprovalScopeNode.checked =
      selectedProject.approvalPolicy.requireApprovalForScopeChanges;
  }

  if (projectRegistrationApprovalHighRiskNode !== null) {
    projectRegistrationApprovalHighRiskNode.checked =
      selectedProject.approvalPolicy.requireApprovalForHighRiskTasks;
  }

  projectPlanningLoopDrafts = clonePlanningLoops(currentStatus?.selectedProject?.planningLoops ?? []);
  if (projectPlanningLoopDrafts.length === 0) {
    projectPlanningLoopDrafts = clonePlanningLoops(DEFAULT_PROJECT_PLANNING_LOOPS);
  }
  renderPlanningLoopEditor();
  renderProjectRegistrationStatus(`Editing ${selectedProject.name}. Submit the form to save.`);
  setProjectCreatorModalOpen(true);
});

projectArchiveButton?.addEventListener("click", async () => {
  const projectId = currentStatus?.selectedProjectId;

  if (projectId === undefined) {
    return;
  }

  renderDesktopStatus(await window.smithlyDesktop.setProjectStatus(projectId, "archived"));
});

projectPlayButton?.addEventListener("click", async () => {
  const projectId = currentStatus?.selectedProjectId;

  if (projectId === undefined) {
    return;
  }

  renderDesktopStatus(await window.smithlyDesktop.playProject(projectId));
});

projectPauseButton?.addEventListener("click", async () => {
  const projectId = currentStatus?.selectedProjectId;

  if (projectId === undefined) {
    return;
  }

  renderDesktopStatus(await window.smithlyDesktop.pauseProject(projectId));
});

projectReactivateButton?.addEventListener("click", async () => {
  const projectId = currentStatus?.selectedProjectId;

  if (projectId === undefined) {
    return;
  }

  renderDesktopStatus(await window.smithlyDesktop.setProjectStatus(projectId, "paused"));
});

projectPlanningButton?.addEventListener("click", () => {
  void activatePlanningScope("project");
});

taskPlanningButton?.addEventListener("click", () => {
  if (currentStatus?.selectedProject?.selectedBacklogItem === undefined) {
    return;
  }

  void activatePlanningScope("task");
});

openProjectCreatorButton?.addEventListener("click", () => {
  void openBootstrapPane();
});

openManualProjectCreatorButton?.addEventListener("click", () => {
  openProjectCreatorModal("create");
});

closeProjectCreatorButton?.addEventListener("click", () => {
  setProjectCreatorModalOpen(false);
  resetProjectRegistrationForm();
});

openMemoryComposerButton?.addEventListener("click", () => {
  resetMemoryComposerForm();
  setMemoryComposerModalOpen(true);
  memoryComposerTitleNode?.focus();
});

closeMemoryComposerButton?.addEventListener("click", () => {
  setMemoryComposerModalOpen(false);
  resetMemoryComposerForm();
});

projectCreatorModalNode?.addEventListener("click", (event) => {
  if (event.target === projectCreatorModalNode) {
    setProjectCreatorModalOpen(false);
    resetProjectRegistrationForm();
  }
});

memoryComposerModalNode?.addEventListener("click", (event) => {
  if (event.target === memoryComposerModalNode) {
    setMemoryComposerModalOpen(false);
    resetMemoryComposerForm();
  }
});

memoryComposerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const title = memoryComposerTitleNode?.value.trim() ?? "";
  const bodyText = memoryComposerBodyNode?.value.trim() ?? "";

  if (title.length === 0 || bodyText.length === 0) {
    setNodeText(memoryComposerStatusNode, "Title and memory text are required.");
    return;
  }

  const noteType = (memoryComposerTypeNode?.value ?? "note") as
    | "decision"
    | "fact"
    | "note"
    | "session_summary";
  const selectedBacklogItemId = currentStatus?.selectedProject?.selectedBacklogItem?.id;
  const status = await window.smithlyDesktop.createMemoryNote({
    bodyText,
    ...(selectedBacklogItemId !== undefined ? { backlogItemId: selectedBacklogItemId } : {}),
    noteType,
    title,
  });

  renderDesktopStatus(status);
  setNodeText(memoryComposerStatusNode, `Stored ${noteType} note.`);
  setMemoryComposerModalOpen(false);
  resetMemoryComposerForm();
});

showOrchestrationButton?.addEventListener("click", () => {
  if (activePlanningPaneKey === null) {
    if (currentStatus?.bootstrapSession !== undefined) {
      void openBootstrapPane();
      return;
    }

    if (currentStatus?.selectedProject !== undefined) {
      void openPlanningPane("project");
      return;
    }
  }

  isFocusPaneMinified = false;
  isOrchestrationVisible = true;
  isCodingVisible = false;
  currentTerminalSignature = "";

  if (currentStatus !== null) {
    renderWorkspaceVisibility(currentStatus);
    renderPlanningPane(currentStatus);
  }

  void persistCurrentUiState();
});

showCodingButton?.addEventListener("click", () => {
  isFocusPaneMinified = false;
  isCodingVisible = true;
  isOrchestrationVisible = false;
  currentCodexTerminalSignature = "";

  if (currentStatus !== null) {
    renderWorkspaceVisibility(currentStatus);
    renderCodexPane(currentStatus);
  }

  void persistCurrentUiState();
});

hideOrchestrationButton?.addEventListener("click", () => {
  isFocusPaneMinified = true;

  if (currentStatus !== null) {
    renderWorkspaceVisibility(currentStatus);
  }

  void persistCurrentUiState();
});

hideCodingButton?.addEventListener("click", () => {
  isFocusPaneMinified = true;

  if (currentStatus !== null) {
    renderWorkspaceVisibility(currentStatus);
  }

  void persistCurrentUiState();
});

closeProjectWorkspaceButton?.addEventListener("click", () => {
  isProjectWorkspaceOpen = false;
  isOrchestrationVisible = false;
  isCodingVisible = false;
  isFocusPaneMinified = false;

  if (currentStatus !== null) {
    renderWorkspaceVisibility(currentStatus);
  }

  void persistCurrentUiState();
});

async function renderStatus(): Promise<void> {
  try {
    initTerminal();
    initCodexTerminal();
    const savedUiState = await window.smithlyDesktop.getSavedUiState();
    const restoredStatus = await restoreSavedUiState(savedUiState);

    renderDesktopStatus(restoredStatus);
  } catch (error: unknown) {
    renderError(error instanceof Error ? error.message : String(error));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function parseMultilineList(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseMetadataEntries(input: string): Record<string, string> {
  const metadataEntries: Record<string, string> = {};

  for (const line of parseMultilineList(input)) {
    const separatorIndex = line.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (key.length > 0 && value.length > 0) {
      metadataEntries[key] = value;
    }
  }

  return metadataEntries;
}

async function restoreSavedUiState(savedUiState: DesktopUiStateSnapshot): Promise<DesktopStatus> {
  let status = await window.smithlyDesktop.getStatus();

  if (savedUiState.selectedProjectId !== undefined) {
    status = await window.smithlyDesktop.selectProject(savedUiState.selectedProjectId);
  }

  if (savedUiState.selectedBacklogItemId !== undefined) {
    status = await window.smithlyDesktop.selectBacklogItem(savedUiState.selectedBacklogItemId);
  }

  isProjectWorkspaceOpen = savedUiState.isProjectWorkspaceOpen ?? false;
  isOrchestrationVisible = savedUiState.isOrchestrationVisible ?? false;
  isCodingVisible = savedUiState.isCodingVisible ?? false;
  isFocusPaneMinified = savedUiState.isFocusPaneMinified ?? false;
  openPlanningPaneKeys = [...(savedUiState.openPlanningPaneKeys ?? [])].filter(isSessionPaneKey);
  openCodexTaskRunIds = [...(savedUiState.openCodexTaskRunIds ?? [])].filter((value) => {
    return value.trim().length > 0;
  });
  activePlanningPaneKey = isSessionPaneKey(savedUiState.activePlanningPaneKey)
    ? savedUiState.activePlanningPaneKey
    : (openPlanningPaneKeys.at(-1) ?? null);
  activeCodexTaskRunId = savedUiState.activeCodexTaskRunId ?? openCodexTaskRunIds.at(-1) ?? null;

  reconcileBootstrapWorkspaceState(status);

  for (const paneKey of openPlanningPaneKeys) {
    if (paneKey === "bootstrap") {
      status = await window.smithlyDesktop.ensureBootstrapSession();
      continue;
    }

    const scope = getPlanningScopeFromPaneKey(paneKey);

    if (scope === undefined) {
      continue;
    }

    if (scope === "bootstrap") {
      status = await window.smithlyDesktop.ensureBootstrapSession();
      continue;
    }

    const backlogItemId = getBacklogItemIdFromPaneKey(paneKey);

    if (scope === "task" && backlogItemId !== undefined) {
      status = await window.smithlyDesktop.selectBacklogItem(backlogItemId);
    }

    status = await window.smithlyDesktop.ensurePlanningSession(scope, backlogItemId);
  }

  for (const taskRunId of openCodexTaskRunIds) {
    status = await window.smithlyDesktop.ensureCodexSession(taskRunId);
  }

  return status;
}

async function persistUiState(status: DesktopStatus): Promise<void> {
  await window.smithlyDesktop.saveUiState({
    ...(activePlanningPaneKey !== null ? { activePlanningPaneKey } : {}),
    ...(activeCodexTaskRunId !== null ? { activeCodexTaskRunId } : {}),
    isFocusPaneMinified,
    isCodingVisible,
    isOrchestrationVisible,
    isProjectWorkspaceOpen,
    ...(openCodexTaskRunIds.length > 0 ? { openCodexTaskRunIds } : {}),
    ...(openPlanningPaneKeys.length > 0 ? { openPlanningPaneKeys } : {}),
    ...(status.selectedBacklogItemId !== undefined
      ? { selectedBacklogItemId: status.selectedBacklogItemId }
      : {}),
    ...(status.selectedProjectId !== undefined
      ? { selectedProjectId: status.selectedProjectId }
      : {}),
  });
}

async function persistCurrentUiState(): Promise<void> {
  if (currentStatus === null) {
    return;
  }

  await persistUiState(currentStatus);
}

function renderUpcomingWork(selectedProject?: DesktopStatus["selectedProject"]): void {
  if (backlogListNode === null) {
    return;
  }

  backlogListNode.innerHTML = "";

  const upcomingBacklogItems =
    selectedProject?.backlogItems.filter((item) => !["done", "cancelled"].includes(item.status)) ??
    [];
  const upcomingTaskRuns =
    selectedProject?.taskRuns.filter((item) => !["done", "cancelled"].includes(item.status)) ?? [];

  if (upcomingBacklogItems.length === 0 && upcomingTaskRuns.length === 0) {
    const emptyNode = document.createElement("p");
    emptyNode.className = "empty-state";
    emptyNode.textContent = "No upcoming work is queued for the selected project.";
    backlogListNode.append(emptyNode);
    return;
  }

  for (const backlogItem of upcomingBacklogItems) {
    const element = document.createElement("article");
    element.className = "list-card";
    element.dataset.selected = String(selectedProject?.selectedBacklogItemId === backlogItem.id);
    element.innerHTML = `
      <div class="list-card__row">
        <strong>${escapeHtml(backlogItem.title)}</strong>
        <span class="list-status">${escapeHtml(backlogItem.status)}</span>
      </div>
      <p>${escapeHtml(backlogItem.subtitle)}</p>
      <time>${escapeHtml(backlogItem.timestamp)}</time>
    `;

    const actions = document.createElement("div");
    actions.className = "list-card__actions";

    const focusButton = document.createElement("button");
    focusButton.type = "button";
    focusButton.textContent = "Focus";
    focusButton.addEventListener("click", async () => {
      await focusBacklogItem(backlogItem.id);
    });

    const taskChatButton = document.createElement("button");
    taskChatButton.type = "button";
    taskChatButton.textContent = "Open Task Chat";
    taskChatButton.addEventListener("click", async () => {
      await focusBacklogItem(backlogItem.id);
      await openPlanningPane("task", backlogItem.id);
    });

    const startCodingButton = document.createElement("button");
    startCodingButton.type = "button";
    startCodingButton.textContent = "Start Coding Task";
    startCodingButton.addEventListener("click", async () => {
      await focusBacklogItem(backlogItem.id);
      await startCodexTask(backlogItem.id);
    });

    actions.append(focusButton, taskChatButton, startCodingButton);
    element.append(actions);
    backlogListNode.append(element);
  }

  for (const taskRun of upcomingTaskRuns) {
    const element = document.createElement("article");
    element.className = "list-card";
    element.innerHTML = `
      <div class="list-card__row">
        <strong>${escapeHtml(taskRun.title)}</strong>
        <span class="list-status">${escapeHtml(taskRun.status)}</span>
      </div>
      <p>${escapeHtml(taskRun.subtitle)}</p>
      <time>${escapeHtml(taskRun.timestamp)}</time>
    `;
    backlogListNode.append(element);
  }
}

async function focusBacklogItem(backlogItemId: string): Promise<void> {
  renderDesktopStatus(await window.smithlyDesktop.selectBacklogItem(backlogItemId));
}

async function openPlanningPane(scope: PlanningScope, backlogItemId?: string): Promise<void> {
  if (currentStatus?.selectedProject === undefined) {
    return;
  }

  const paneKey = createSessionPaneKey(scope, backlogItemId);

  if (!openPlanningPaneKeys.includes(paneKey)) {
    openPlanningPaneKeys = [...openPlanningPaneKeys, paneKey];
  }

  if (scope === "task" && backlogItemId !== undefined) {
    await focusBacklogItem(backlogItemId);
  }

  activePlanningPaneKey = paneKey;
  isProjectWorkspaceOpen = true;
  isFocusPaneMinified = false;
  isOrchestrationVisible = true;
  isCodingVisible = false;
  currentTerminalSignature = "";
  void persistCurrentUiState();
  renderPlanningPending(scope);
  renderDesktopStatus(await window.smithlyDesktop.ensurePlanningSession(scope, backlogItemId));
  void pollStatus(4, 250);
}

async function openBootstrapPane(): Promise<void> {
  const paneKey = createBootstrapPaneKey();

  if (!openPlanningPaneKeys.includes(paneKey)) {
    openPlanningPaneKeys = [...openPlanningPaneKeys, paneKey];
  }

  activePlanningPaneKey = paneKey;
  isProjectWorkspaceOpen = true;
  isFocusPaneMinified = false;
  isOrchestrationVisible = true;
  isCodingVisible = false;
  currentTerminalSignature = "";
  void persistCurrentUiState();
  renderPlanningPending("bootstrap");
  renderDesktopStatus(await window.smithlyDesktop.ensureBootstrapSession());
  void pollStatus(4, 250);
}

async function startCodexTask(backlogItemId: string): Promise<void> {
  const status = await window.smithlyDesktop.startCodexSession(
    backlogItemId,
    "Start Codex work from the selected backlog item.",
  );
  const newestSession = status.selectedProject?.codexSessions.at(-1);

  if (newestSession === undefined) {
    renderDesktopStatus(status);
    return;
  }

  isCodingVisible = true;
  isOrchestrationVisible = false;
  isFocusPaneMinified = false;
  if (!openCodexTaskRunIds.includes(newestSession.taskRunId)) {
    openCodexTaskRunIds = [...openCodexTaskRunIds, newestSession.taskRunId];
  }
  activeCodexTaskRunId = newestSession.taskRunId;
  currentCodexTerminalSignature = "";
  renderDesktopStatus(status);
  void pollStatus(4, 250);
}

function closePlanningPane(paneKey: SessionPaneKey, status: DesktopStatus): void {
  openPlanningPaneKeys = openPlanningPaneKeys.filter((candidate) => candidate !== paneKey);

  if (activePlanningPaneKey === paneKey) {
    activePlanningPaneKey = openPlanningPaneKeys.at(-1) ?? null;
  }

  currentTerminalSignature = "";
  renderPlanningPane(status);
  void persistCurrentUiState();
}

function closeCodexPane(taskRunId: string, status: DesktopStatus): void {
  openCodexTaskRunIds = openCodexTaskRunIds.filter((candidate) => candidate !== taskRunId);

  if (activeCodexTaskRunId === taskRunId) {
    activeCodexTaskRunId = openCodexTaskRunIds.at(-1) ?? null;
  }

  currentCodexTerminalSignature = "";
  renderCodexPane(status);
  void persistCurrentUiState();
}

function getPlanningPaneLabel(status: DesktopStatus | null, paneKey: SessionPaneKey): string {
  const target = getPlanningTarget(status, paneKey);
  const scope = getPlanningScopeFromPaneKey(paneKey);

  if (scope === "bootstrap") {
    return "Project Bootstrap";
  }

  if (scope === "project") {
    return "Plan / Approve More";
  }

  return target?.backlogItemTitle ? `Task: ${target.backlogItemTitle}` : "Task Chat";
}

function getPlanningTarget(
  status: DesktopStatus | null,
  paneKey: SessionPaneKey | null,
):
  | {
      readonly backlogItemTitle?: string;
      readonly session?: DesktopPlanningSession;
      readonly thread?: DesktopChatThread;
    }
  | undefined {
  if (paneKey === "bootstrap" && status?.bootstrapSession !== undefined) {
    return {
      session: {
        status: status.bootstrapSession.status,
        terminalKey: status.bootstrapSession.terminalKey,
        workerSessionId: status.bootstrapSession.terminalKey,
      },
      thread: {
        kind: "bootstrap",
        messages: status.bootstrapSession.messages,
        threadId: "bootstrap",
        title: "Project bootstrap",
      },
    };
  }

  if (status?.selectedProject === undefined || paneKey === null) {
    return undefined;
  }

  if (paneKey.startsWith("project:")) {
    return {
      ...(status.selectedProject.projectPlanningSession !== undefined
        ? { session: status.selectedProject.projectPlanningSession }
        : {}),
      ...(status.selectedProject.projectPlanningChat !== undefined
        ? { thread: status.selectedProject.projectPlanningChat }
        : {}),
    };
  }

  const backlogItemId = getBacklogItemIdFromPaneKey(paneKey);
  const selectedBacklogItem =
    backlogItemId !== undefined && status.selectedProject.selectedBacklogItem?.id === backlogItemId
      ? status.selectedProject.selectedBacklogItem
      : undefined;
  const backlogListItem =
    backlogItemId !== undefined
      ? status.selectedProject.backlogItems.find((item) => item.id === backlogItemId)
      : undefined;

  return {
    ...(selectedBacklogItem?.title !== undefined || backlogListItem?.title !== undefined
      ? { backlogItemTitle: selectedBacklogItem?.title ?? backlogListItem?.title ?? "Task Chat" }
      : {}),
    ...(status.selectedProject.taskPlanningSession !== undefined
      ? { session: status.selectedProject.taskPlanningSession }
      : {}),
    ...(status.selectedProject.taskPlanningChat !== undefined
      ? { thread: status.selectedProject.taskPlanningChat }
      : {}),
  };
}

function getPlanningScopeFromPaneKey(
  paneKey: SessionPaneKey | null,
): PlanningPaneScope | undefined {
  if (paneKey === null) {
    return undefined;
  }

  if (paneKey === "bootstrap") {
    return "bootstrap";
  }

  return paneKey.startsWith("project:") ? "project" : "task";
}

function getBacklogItemIdFromPaneKey(paneKey: SessionPaneKey | null): string | undefined {
  if (paneKey === null || paneKey === "bootstrap" || !paneKey.startsWith("task:")) {
    return undefined;
  }

  const [, backlogItemId] = paneKey.split(":", 2);
  return backlogItemId || undefined;
}

function isSessionPaneKey(value: string | undefined): value is SessionPaneKey {
  return (
    value !== undefined &&
    (value === "bootstrap" || value.startsWith("project:") || value.startsWith("task:"))
  );
}

window.addEventListener("beforeunload", () => {
  void persistCurrentUiState();
});

void renderStatus();

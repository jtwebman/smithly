/// <reference lib="dom" />

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

type PlanningScope = "project" | "task";
type SessionPaneKey = `project:${string}` | `task:${string}`;

interface DesktopProjectSummary {
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

interface DesktopProjectRegistrationInput {
  readonly approvalPolicy: {
    readonly requireApprovalForHighRiskTasks: boolean;
    readonly requireApprovalForNewBacklogItems: boolean;
    readonly requireApprovalForScopeChanges: boolean;
  };
  readonly metadata: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly repoPath: string;
  readonly verificationCommands: readonly string[];
}

interface DesktopStatus {
  readonly appVersion: string;
  readonly dataDirectory: string;
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
    readonly approvals: readonly DesktopListItem[];
    readonly blockers: readonly DesktopListItem[];
    readonly events: readonly DesktopEventItem[];
    readonly projectPlanningChat?: DesktopChatThread;
    readonly projectPlanningSession?: DesktopPlanningSession;
    readonly taskPlanningChat?: DesktopChatThread;
    readonly taskPlanningSession?: DesktopPlanningSession;
    readonly selectedBacklogItemId?: string;
    readonly selectedBacklogItem?: DesktopBacklogDetail;
  };
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
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly reviewMode: string;
  readonly riskLevel: string;
  readonly status: string;
  readonly scopeSummary: string;
  readonly acceptanceCriteria: readonly string[];
}

interface DesktopPlanningSession {
  readonly workerSessionId: string;
  readonly terminalKey: string;
  readonly status: string;
}

interface PlanningOutputEvent {
  readonly terminalKey: string;
  readonly rawData: string;
  readonly entries: readonly DesktopChatMessage[];
}

interface SmithlyDesktopApi {
  getStatus(): Promise<DesktopStatus>;
  registerProject(input: DesktopProjectRegistrationInput): Promise<DesktopStatus>;
  selectProject(projectId: string): Promise<DesktopStatus>;
  selectBacklogItem(backlogItemId: string): Promise<DesktopStatus>;
  setProjectStatus(projectId: string, status: "active" | "archived"): Promise<DesktopStatus>;
  updateProject(
    input: DesktopProjectRegistrationInput & { projectId: string },
  ): Promise<DesktopStatus>;
  ensurePlanningSession(scope: PlanningScope, backlogItemId?: string): Promise<DesktopStatus>;
  submitPlanningInput(
    scope: PlanningScope,
    backlogItemId: string | undefined,
    bodyText: string,
  ): Promise<DesktopStatus>;
  writePlanningTerminal(terminalKey: string, data: string): Promise<void>;
  resizePlanningTerminal(terminalKey: string, cols: number, rows: number): Promise<void>;
  onPlanningOutput(listener: (payload: PlanningOutputEvent) => void): () => void;
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
const projectListNode = document.getElementById("project-list");
const projectWorkspaceNode = document.getElementById("project-workspace");
const projectWorkspaceTitleNode = document.getElementById("project-workspace-title");
const closeProjectWorkspaceButton = document.getElementById(
  "close-project-workspace-button",
) as HTMLButtonElement | null;
const showOrchestrationButton = document.getElementById(
  "show-orchestration-button",
) as HTMLButtonElement | null;
const orchestrationShellNode = document.getElementById("orchestration-shell");
const hideOrchestrationButton = document.getElementById(
  "hide-orchestration-button",
) as HTMLButtonElement | null;
const projectCreatorModalNode = document.getElementById("project-creator-modal");
const projectCreatorTitleNode = document.getElementById("project-creator-title");
const openProjectCreatorButton = document.getElementById(
  "open-project-creator-button",
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
const projectRegistrationStatusNode = document.getElementById("project-registration-status");
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
const planningTitleNode = document.getElementById("planning-title");
const planningStatusNode = document.getElementById("planning-status");
const planningHistoryNode = document.getElementById("planning-history");
const projectPlanningButton = document.getElementById(
  "project-planning-button",
) as HTMLButtonElement | null;
const projectEditButton = document.getElementById(
  "project-edit-button",
) as HTMLButtonElement | null;
const projectArchiveButton = document.getElementById(
  "project-archive-button",
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

let currentStatus: DesktopStatus | null = null;
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let currentTerminalSignature = "";
let editingProjectId: string | null = null;
let activePlanningPaneKey: SessionPaneKey | null = null;
let openPlanningPaneKeys: SessionPaneKey[] = [];
let isProjectWorkspaceOpen = false;
let isOrchestrationVisible = false;
const terminalBuffers = new Map<string, string[]>();
let terminalResizeObserver: ResizeObserver | null = null;

window.smithlyDesktop.onPlanningOutput((payload) => {
  const chunks = terminalBuffers.get(payload.terminalKey) ?? [];

  chunks.push(payload.rawData);
  terminalBuffers.set(payload.terminalKey, chunks.slice(-500));

  const activeSession = getActivePlanningSession(currentStatus, activePlanningPaneKey);

  if (activeSession?.terminalKey === payload.terminalKey) {
    terminal?.write(payload.rawData);
  }

  void pollStatus(6, 250);
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
          <p class="project-card__meta">Verification: ${escapeHtml(project.verificationSummary)}</p>
          <p class="project-card__meta">Approval: ${escapeHtml(project.approvalPolicySummary)}</p>
          <p class="project-card__meta">Metadata: ${escapeHtml(project.metadataSummary)}</p>
        </div>
        <span class="project-status" data-status="${escapeHtml(project.status)}">${escapeHtml(project.status)}</span>
      </header>
      <dl class="project-metrics">
        <div>
          <dt>Active Tasks</dt>
          <dd>${project.activeTaskCount}</dd>
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
        <button type="button" data-project-id="${escapeHtml(project.id)}">Open Workspace</button>
      </div>
    `;
    article.querySelector("button")?.addEventListener("click", async () => {
      isProjectWorkspaceOpen = true;
      renderDesktopStatus(await window.smithlyDesktop.selectProject(project.id));
    });
    projectListNode.append(article);
  }
}

function createSessionPaneKey(scope: PlanningScope, backlogItemId?: string): SessionPaneKey {
  if (scope === "project") {
    return `project:${currentStatus?.selectedProjectId ?? "missing"}`;
  }

  return `task:${backlogItemId ?? "missing"}`;
}

function renderProjectRegistrationStatus(message: string): void {
  setNodeText(projectRegistrationStatusNode, message);
}

function setProjectCreatorModalOpen(isOpen: boolean): void {
  projectCreatorModalNode?.toggleAttribute("hidden", !isOpen);
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

  setNodeText(projectCreatorTitleNode, "Create project");
  renderProjectRegistrationStatus("");
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

function updateTerminalTheme(mode: "dark" | "light"): void {
  if (terminal === null) {
    return;
  }

  terminal.options.theme =
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
}

function renderWorkspaceVisibility(status: DesktopStatus): void {
  const hasSelectedProject = status.selectedProject !== undefined;
  const showWorkspace = isProjectWorkspaceOpen && hasSelectedProject;
  const showOrchestration = showWorkspace && isOrchestrationVisible;

  projectWorkspaceNode?.toggleAttribute("hidden", !showWorkspace);
  orchestrationShellNode?.toggleAttribute("hidden", !showOrchestration);

  if (projectWorkspaceTitleNode !== null) {
    const selectedProjectName = status.projects.find(
      (project) => project.id === status.selectedProjectId,
    )?.name;
    projectWorkspaceTitleNode.textContent = selectedProjectName
      ? `Project workspace: ${selectedProjectName}`
      : "Project workspace";
  }

  if (showOrchestrationButton !== null) {
    showOrchestrationButton.disabled = !hasSelectedProject;
  }

  if (showOrchestration) {
    window.requestAnimationFrame(() => {
      refitVisibleTerminal(status);
    });
  }
}

function renderPlanningPane(status: DesktopStatus): void {
  const activeThread = getActivePlanningThread(status, activePlanningPaneKey);
  const activeSession = getActivePlanningSession(status, activePlanningPaneKey);
  const activeScope = getPlanningScopeFromPaneKey(activePlanningPaneKey);
  const selectedBacklogItem = status.selectedProject?.selectedBacklogItem;
  const hasSelectedProject = status.selectedProject !== undefined;
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
      : "Project orchestration";
  }

  if (projectEditButton !== null) {
    projectEditButton.disabled = !hasSelectedProject;
  }

  if (projectArchiveButton !== null) {
    projectArchiveButton.disabled = !hasSelectedProject;
  }

  if (projectReactivateButton !== null) {
    projectReactivateButton.disabled = selectedProjectSummary?.status !== "archived";
  }

  setNodeText(planningTitleNode, activeThread?.title ?? "No planning thread");
  setNodeText(
    planningStatusNode,
    !hasSelectedProject
      ? "Register a local project to enable planning."
      : activePlanningPaneKey === null
        ? "Open a project or task Claude session to begin."
        : activeSession
          ? `${activeScope} planning session ${activeSession.status}`
          : `${activeScope} planning session idle`,
  );
  setNodeText(shellStatusNode, activeSession ? `${activeScope} TUI attached` : "Shell ready");
  setNodeText(
    terminalCaptionNode,
    !hasSelectedProject
      ? "Register a local git repository to attach a planning session."
      : activeThread
        ? "Type directly into the attached Claude TUI when you need to interact."
        : "Open a Claude pane to attach a planning session.",
  );

  renderPlanningHistory(activeThread?.messages ?? []);
  renderSelectedBacklog(selectedBacklogItem);
  syncTerminalPane(status);
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

      activePlanningPaneKey = paneKey;
      renderPlanningPane(currentStatus ?? status);
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
      ? `priority ${backlogItem.priority} | ${backlogItem.riskLevel} risk | ${backlogItem.reviewMode} review`
      : "No backlog metadata selected",
  );
  setNodeText(
    selectedBacklogScopeNode,
    backlogItem?.scopeSummary ??
      "Project planning is active. Switch to task planning to focus one backlog item.",
  );

  if (selectedBacklogCriteriaNode === null) {
    return;
  }

  selectedBacklogCriteriaNode.innerHTML = "";

  if (backlogItem === undefined || backlogItem.acceptanceCriteria.length === 0) {
    const emptyNode = document.createElement("li");
    emptyNode.textContent = "No acceptance criteria recorded yet.";
    selectedBacklogCriteriaNode.append(emptyNode);
    return;
  }

  for (const criterion of backlogItem.acceptanceCriteria) {
    const item = document.createElement("li");
    item.textContent = criterion;
    selectedBacklogCriteriaNode.append(item);
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

  if (status.selectedProject === undefined) {
    terminal.writeln("[smithly] Register a local git repository to begin.");
    return;
  }

  if (activeSession === undefined) {
    terminal.writeln("[smithly] Open a Claude pane to attach a planning session.");
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
  renderEvents(eventLogNode, selectedProject?.events ?? []);
  renderPlanningPane(status);
}

function renderError(message: string): void {
  setNodeText(appVersionNode, "Unavailable");
  setNodeText(themeNode, "Unavailable");
  setNodeText(dataDirectoryNode, "Unavailable");
  setNodeText(projectCountNode, "Unavailable");
  setNodeText(shellStatusNode, message);
}

function renderDesktopStatus(status: DesktopStatus): void {
  currentStatus = status;
  applyTheme(status.resolvedThemeMode);
  updateTerminalTheme(status.resolvedThemeMode);
  setNodeText(appVersionNode, status.appVersion);
  setNodeText(themeNode, `${status.themePreference} -> ${status.resolvedThemeMode}`);
  setNodeText(dataDirectoryNode, status.dataDirectory);
  setNodeText(projectCountNode, String(status.projectCount));
  renderProjects(status);
  renderWorkspaceVisibility(status);
  renderSelectedProject(status);
  setNodeText(shellStatusNode, "Shell ready");
}

async function activatePlanningScope(scope: PlanningScope): Promise<void> {
  if (currentStatus?.selectedProject === undefined) {
    return;
  }

  const backlogItemId =
    scope === "task" ? currentStatus.selectedProject.selectedBacklogItem?.id : undefined;

  await openPlanningPane(scope, backlogItemId);
}

function renderPlanningPending(scope: PlanningScope): void {
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

  if (repoPath.length === 0) {
    renderProjectRegistrationStatus("Local repo path is required.");
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

projectReactivateButton?.addEventListener("click", async () => {
  const projectId = currentStatus?.selectedProjectId;

  if (projectId === undefined) {
    return;
  }

  renderDesktopStatus(await window.smithlyDesktop.setProjectStatus(projectId, "active"));
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
  openProjectCreatorModal("create");
});

closeProjectCreatorButton?.addEventListener("click", () => {
  setProjectCreatorModalOpen(false);
  resetProjectRegistrationForm();
});

projectCreatorModalNode?.addEventListener("click", (event) => {
  if (event.target === projectCreatorModalNode) {
    setProjectCreatorModalOpen(false);
    resetProjectRegistrationForm();
  }
});

showOrchestrationButton?.addEventListener("click", () => {
  isOrchestrationVisible = true;
  currentTerminalSignature = "";

  if (currentStatus !== null) {
    renderWorkspaceVisibility(currentStatus);
    renderPlanningPane(currentStatus);
  }
});

hideOrchestrationButton?.addEventListener("click", () => {
  isOrchestrationVisible = false;

  if (currentStatus !== null) {
    renderWorkspaceVisibility(currentStatus);
  }
});

closeProjectWorkspaceButton?.addEventListener("click", () => {
  isProjectWorkspaceOpen = false;
  isOrchestrationVisible = false;

  if (currentStatus !== null) {
    renderWorkspaceVisibility(currentStatus);
  }
});

async function renderStatus(): Promise<void> {
  try {
    initTerminal();
    const status = await window.smithlyDesktop.getStatus();
    renderDesktopStatus(status);
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

    actions.append(focusButton, taskChatButton);
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
  renderPlanningPending(scope);
  renderDesktopStatus(await window.smithlyDesktop.ensurePlanningSession(scope, backlogItemId));
  void pollStatus(4, 250);
}

function closePlanningPane(paneKey: SessionPaneKey, status: DesktopStatus): void {
  openPlanningPaneKeys = openPlanningPaneKeys.filter((candidate) => candidate !== paneKey);

  if (activePlanningPaneKey === paneKey) {
    activePlanningPaneKey = openPlanningPaneKeys.at(-1) ?? null;
  }

  currentTerminalSignature = "";
  renderPlanningPane(status);
}

function getPlanningPaneLabel(status: DesktopStatus | null, paneKey: SessionPaneKey): string {
  const target = getPlanningTarget(status, paneKey);
  const scope = getPlanningScopeFromPaneKey(paneKey);

  if (scope === "project") {
    return "Project Chat";
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

function getPlanningScopeFromPaneKey(paneKey: SessionPaneKey | null): PlanningScope | undefined {
  if (paneKey === null) {
    return undefined;
  }

  return paneKey.startsWith("project:") ? "project" : "task";
}

function getBacklogItemIdFromPaneKey(paneKey: SessionPaneKey | null): string | undefined {
  if (paneKey === null || !paneKey.startsWith("task:")) {
    return undefined;
  }

  const [, backlogItemId] = paneKey.split(":", 2);
  return backlogItemId || undefined;
}

void renderStatus();

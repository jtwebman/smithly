/// <reference lib="dom" />

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

type PlanningScope = "project" | "task";

interface DesktopProjectSummary {
  readonly approvalPolicySummary: string;
  readonly id: string;
  readonly metadataSummary: string;
  readonly name: string;
  readonly repoPath: string;
  readonly status: string;
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
  ensurePlanningSession(scope: PlanningScope, backlogItemId?: string): Promise<DesktopStatus>;
  submitPlanningInput(
    scope: PlanningScope,
    backlogItemId: string | undefined,
    bodyText: string,
  ): Promise<DesktopStatus>;
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
const planningTitleNode = document.getElementById("planning-title");
const planningStatusNode = document.getElementById("planning-status");
const planningHistoryNode = document.getElementById("planning-history");
const planningForm = document.getElementById("planning-input-form");
const planningInputNode = document.getElementById("planning-input") as HTMLInputElement | null;
const projectPlanningButton = document.getElementById(
  "project-planning-button",
) as HTMLButtonElement | null;
const taskPlanningButton = document.getElementById(
  "task-planning-button",
) as HTMLButtonElement | null;
const selectedBacklogTitleNode = document.getElementById("selected-backlog-title");
const selectedBacklogStatusNode = document.getElementById("selected-backlog-status");
const selectedBacklogScopeNode = document.getElementById("selected-backlog-scope");
const selectedBacklogCriteriaNode = document.getElementById("selected-backlog-criteria");

let currentStatus: DesktopStatus | null = null;
let activePlanningScope: PlanningScope = "project";
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let currentTerminalSignature = "";

window.smithlyDesktop.onPlanningOutput((payload) => {
  const activeSession = getActivePlanningSession(currentStatus, activePlanningScope);

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
    `;
    projectListNode.append(article);
  }
}

function renderProjectRegistrationStatus(message: string): void {
  setNodeText(projectRegistrationStatusNode, message);
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
    disableStdin: true,
    fontFamily: '"Iosevka Custom", "JetBrains Mono", monospace',
    fontSize: 13,
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalNode);
  fitAddon.fit();

  window.addEventListener("resize", () => {
    fitAddon?.fit();
  });
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

function renderPlanningPane(status: DesktopStatus): void {
  const activeThread = getActivePlanningThread(status, activePlanningScope);
  const activeSession = getActivePlanningSession(status, activePlanningScope);
  const selectedBacklogItem = status.selectedProject?.selectedBacklogItem;
  const hasSelectedProject = status.selectedProject !== undefined;

  if (projectPlanningButton !== null) {
    projectPlanningButton.dataset.active = String(activePlanningScope === "project");
    projectPlanningButton.disabled = !hasSelectedProject;
  }

  if (taskPlanningButton !== null) {
    taskPlanningButton.dataset.active = String(activePlanningScope === "task");
    taskPlanningButton.disabled = selectedBacklogItem === undefined;
  }

  if (planningInputNode !== null) {
    planningInputNode.disabled = !hasSelectedProject;
  }

  setNodeText(planningTitleNode, activeThread?.title ?? "No planning thread");
  setNodeText(
    planningStatusNode,
    !hasSelectedProject
      ? "Register a local project to enable planning."
      : activeSession
        ? `${activePlanningScope} planning session ${activeSession.status}`
        : `${activePlanningScope} planning session idle`,
  );
  setNodeText(
    terminalCaptionNode,
    !hasSelectedProject
      ? "Register a local git repository to attach a planning session."
      : activeThread
        ? "Claude planning transcript attached to the selected thread."
        : "Select a planning thread to start a Claude planning session.",
  );

  renderPlanningHistory(activeThread?.messages ?? []);
  renderSelectedBacklog(selectedBacklogItem);
  syncTerminalTranscript(status);
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

function syncTerminalTranscript(status: DesktopStatus): void {
  const activeThread = getActivePlanningThread(status, activePlanningScope);
  const signature = [
    activePlanningScope,
    activeThread?.threadId ?? "none",
    activeThread?.messages.length ?? 0,
    status.resolvedThemeMode,
  ].join(":");

  if (terminal === null || signature === currentTerminalSignature) {
    return;
  }

  currentTerminalSignature = signature;
  terminal.reset();
  terminal.writeln(`smithly-shell: ${activePlanningScope} planning transcript attached`);
  terminal.writeln(`theme: ${status.resolvedThemeMode} (${status.themePreference})`);

  if (status.selectedProject === undefined) {
    terminal.writeln("[smithly] Register a local git repository to begin.");
    return;
  }

  if (activeThread === undefined) {
    terminal.writeln("[smithly] No planning thread is available.");
    return;
  }

  terminal.writeln(`thread: ${activeThread.title}`);

  for (const message of activeThread.messages) {
    terminal.writeln(formatTranscriptLine(message));
  }

  fitAddon?.fit();
}

function formatTranscriptLine(message: DesktopChatMessage): string {
  switch (message.role) {
    case "human":
      return `operator> ${message.bodyText}`;
    case "system":
      return `smithly> ${message.bodyText}`;
    default:
      return `claude> ${message.bodyText}`;
  }
}

function applyTheme(mode: "dark" | "light"): void {
  document.documentElement.dataset.theme = mode;
}

function renderSelectedProject(status: DesktopStatus): void {
  const selectedProject = status.selectedProject;

  renderList(
    backlogListNode,
    selectedProject?.backlogItems ?? [],
    "No backlog items are available for the selected project.",
  );
  renderList(
    taskListNode,
    selectedProject?.taskRuns ?? [],
    "No task runs are active for the selected project.",
  );
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
  renderSelectedProject(status);
  setNodeText(shellStatusNode, "Shell ready");
}

async function activatePlanningScope(scope: PlanningScope): Promise<void> {
  activePlanningScope = scope;

  if (currentStatus !== null) {
    renderPlanningPane(currentStatus);
  }

  if (currentStatus?.selectedProject === undefined) {
    return;
  }

  const backlogItemId =
    scope === "task" ? currentStatus?.selectedProject?.selectedBacklogItem?.id : undefined;

  renderPlanningPending(scope);
  renderDesktopStatus(await window.smithlyDesktop.ensurePlanningSession(scope, backlogItemId));
  void pollStatus(4, 250);
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
  scope: PlanningScope,
): DesktopChatThread | undefined {
  if (status?.selectedProject === undefined) {
    return undefined;
  }

  return scope === "project"
    ? status.selectedProject.projectPlanningChat
    : status.selectedProject.taskPlanningChat;
}

function getActivePlanningSession(
  status: DesktopStatus | null,
  scope: PlanningScope,
): DesktopPlanningSession | undefined {
  if (status?.selectedProject === undefined) {
    return undefined;
  }

  return scope === "project"
    ? status.selectedProject.projectPlanningSession
    : status.selectedProject.taskPlanningSession;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

planningForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (planningInputNode === null || currentStatus?.selectedProject === undefined) {
    return;
  }

  const bodyText = planningInputNode.value.trim();

  if (bodyText.length === 0) {
    return;
  }

  const backlogItemId =
    activePlanningScope === "task"
      ? currentStatus.selectedProject.selectedBacklogItem?.id
      : undefined;

  renderDesktopStatus(
    await window.smithlyDesktop.submitPlanningInput(activePlanningScope, backlogItemId, bodyText),
  );
  planningInputNode.value = "";
  void pollStatus(8, 250);
});

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

  renderProjectRegistrationStatus("Registering local project...");

  try {
    const previousStatus = currentStatus;
    const status = await window.smithlyDesktop.registerProject({
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
    });

    renderDesktopStatus(status);
    renderProjectRegistrationStatus(
      `Registered ${status.projects[status.projects.length - 1]?.name ?? "project"}.`,
    );
    projectRegistrationPathNode.value = "";

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

    if (previousStatus?.selectedProject === undefined && status.selectedProject !== undefined) {
      await activatePlanningScope("project");
    }
  } catch (error: unknown) {
    renderProjectRegistrationStatus(error instanceof Error ? error.message : String(error));
  }
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

async function renderStatus(): Promise<void> {
  try {
    initTerminal();
    const status = await window.smithlyDesktop.getStatus();
    renderDesktopStatus(status);

    if (status.selectedProject !== undefined) {
      await activatePlanningScope("project");
    }
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

void renderStatus();

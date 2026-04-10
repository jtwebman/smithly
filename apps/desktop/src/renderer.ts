/// <reference lib="dom" />

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

interface DesktopProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly repoPath: string;
  readonly status: string;
  readonly activeTaskCount: number;
  readonly activeSessionCount: number;
  readonly backlogCount: number;
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

interface SmithlyDesktopApi {
  getStatus(): Promise<DesktopStatus>;
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
const backlogListNode = document.getElementById("backlog-list");
const taskListNode = document.getElementById("task-list");
const approvalsListNode = document.getElementById("approvals-list");
const blockersListNode = document.getElementById("blockers-list");
const eventLogNode = document.getElementById("event-log");
const terminalNode = document.getElementById("terminal");
const terminalCaptionNode = document.getElementById("terminal-caption");
const shellStatusNode = document.getElementById("shell-status");

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

function renderTerminal(status: DesktopStatus): void {
  if (terminalNode === null) {
    return;
  }

  terminalNode.innerHTML = "";

  const terminal = new Terminal({
    convertEol: true,
    cursorBlink: false,
    disableStdin: true,
    fontFamily: '"Iosevka Custom", "JetBrains Mono", monospace',
    fontSize: 13,
    theme:
      status.resolvedThemeMode === "dark"
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
          },
  });
  const fitAddon = new FitAddon();

  terminal.loadAddon(fitAddon);
  terminal.open(terminalNode);
  fitAddon.fit();

  terminal.writeln("smithly-shell: dashboard session attached");
  terminal.writeln(`theme: ${status.resolvedThemeMode} (${status.themePreference})`);
  terminal.writeln(`projects loaded: ${status.projectCount}`);

  for (const project of status.projects) {
    terminal.writeln(
      `${project.name} | status=${project.status} | active_sessions=${project.activeSessionCount} | active_tasks=${project.activeTaskCount}`,
    );
  }

  setNodeText(terminalCaptionNode, "Read-only bootstrap pane. Live PTY wiring comes next.");
  setNodeText(shellStatusNode, "Shell ready");

  window.addEventListener("resize", () => {
    fitAddon.fit();
  });
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
}

function renderError(message: string): void {
  setNodeText(appVersionNode, "Unavailable");
  setNodeText(themeNode, "Unavailable");
  setNodeText(dataDirectoryNode, "Unavailable");
  setNodeText(projectCountNode, "Unavailable");
  setNodeText(shellStatusNode, message);
}

async function renderStatus(): Promise<void> {
  try {
    const status = await window.smithlyDesktop.getStatus();

    applyTheme(status.resolvedThemeMode);
    setNodeText(appVersionNode, status.appVersion);
    setNodeText(themeNode, `${status.themePreference} -> ${status.resolvedThemeMode}`);
    setNodeText(dataDirectoryNode, status.dataDirectory);
    setNodeText(projectCountNode, String(status.projectCount));
    renderProjects(status);
    renderSelectedProject(status);
    renderTerminal(status);
  } catch (error: unknown) {
    renderError(error instanceof Error ? error.message : String(error));
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

void renderStatus();

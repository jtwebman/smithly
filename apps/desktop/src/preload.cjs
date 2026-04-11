const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smithlyDesktop", {
  getStatus() {
    return ipcRenderer.invoke("smithly:desktop-status");
  },
  getSavedUiState() {
    return ipcRenderer.invoke("smithly:ui-state:get");
  },
  registerProject(input) {
    return ipcRenderer.invoke("smithly:project-register", input);
  },
  saveUiState(state) {
    return ipcRenderer.invoke("smithly:ui-state:save", state);
  },
  selectProject(projectId) {
    return ipcRenderer.invoke("smithly:project-select", projectId);
  },
  selectBacklogItem(backlogItemId) {
    return ipcRenderer.invoke("smithly:backlog-select", backlogItemId);
  },
  updateProject(input) {
    return ipcRenderer.invoke("smithly:project-update", input);
  },
  setProjectStatus(projectId, status) {
    return ipcRenderer.invoke("smithly:project-set-status", projectId, status);
  },
  playProject(projectId) {
    return ipcRenderer.invoke("smithly:project-play", projectId);
  },
  pauseProject(projectId) {
    return ipcRenderer.invoke("smithly:project-pause", projectId);
  },
  ensurePlanningSession(scope, backlogItemId) {
    return ipcRenderer.invoke("smithly:planning-session:ensure", scope, backlogItemId);
  },
  submitPlanningInput(scope, backlogItemId, bodyText) {
    return ipcRenderer.invoke("smithly:planning-session:submit", scope, backlogItemId, bodyText);
  },
  ensureCodexSession(taskRunId) {
    return ipcRenderer.invoke("smithly:codex-session:ensure", taskRunId);
  },
  startCodexSession(backlogItemId, summaryText) {
    return ipcRenderer.invoke("smithly:codex-session:start", backlogItemId, summaryText);
  },
  updateReviewRun(reviewRunId, status, summaryText) {
    return ipcRenderer.invoke("smithly:review-run:update", reviewRunId, status, summaryText);
  },
  deferReviewRun(reviewRunId, summaryText) {
    return ipcRenderer.invoke("smithly:review-run:defer", reviewRunId, summaryText);
  },
  commentOnReviewRun(reviewRunId, summaryText) {
    return ipcRenderer.invoke("smithly:review-run:comment", reviewRunId, summaryText);
  },
  mergeTaskRun(taskRunId) {
    return ipcRenderer.invoke("smithly:task-merge", taskRunId);
  },
  createMemoryNote(input) {
    return ipcRenderer.invoke("smithly:memory-note:create", input);
  },
  writeCodexTerminal(terminalKey, data) {
    return ipcRenderer.invoke("smithly:codex-session:write", terminalKey, data);
  },
  resizeCodexTerminal(terminalKey, cols, rows) {
    return ipcRenderer.invoke("smithly:codex-session:resize", terminalKey, cols, rows);
  },
  writePlanningTerminal(terminalKey, data) {
    return ipcRenderer.invoke("smithly:planning-session:write", terminalKey, data);
  },
  resizePlanningTerminal(terminalKey, cols, rows) {
    return ipcRenderer.invoke("smithly:planning-session:resize", terminalKey, cols, rows);
  },
  onPlanningOutput(listener) {
    const eventName = "smithly:planning-output";
    const wrappedListener = (_event, payload) => {
      listener(payload);
    };

    ipcRenderer.on(eventName, wrappedListener);

    return () => {
      ipcRenderer.removeListener(eventName, wrappedListener);
    };
  },
  onCodexOutput(listener) {
    const eventName = "smithly:codex-output";
    const wrappedListener = (_event, payload) => {
      listener(payload);
    };

    ipcRenderer.on(eventName, wrappedListener);

    return () => {
      ipcRenderer.removeListener(eventName, wrappedListener);
    };
  },
  onStatusUpdate(listener) {
    const eventName = "smithly:desktop-status-updated";
    const wrappedListener = (_event, payload) => {
      listener(payload);
    };

    ipcRenderer.on(eventName, wrappedListener);

    return () => {
      ipcRenderer.removeListener(eventName, wrappedListener);
    };
  },
});

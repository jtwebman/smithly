const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smithlyDesktop", {
  getStatus() {
    return ipcRenderer.invoke("smithly:desktop-status");
  },
  registerProject(input) {
    return ipcRenderer.invoke("smithly:project-register", input);
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
  ensurePlanningSession(scope, backlogItemId) {
    return ipcRenderer.invoke("smithly:planning-session:ensure", scope, backlogItemId);
  },
  submitPlanningInput(scope, backlogItemId, bodyText) {
    return ipcRenderer.invoke("smithly:planning-session:submit", scope, backlogItemId, bodyText);
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

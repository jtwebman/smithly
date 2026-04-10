const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smithlyDesktop", {
  getStatus() {
    return ipcRenderer.invoke("smithly:desktop-status");
  },
  ensurePlanningSession(scope, backlogItemId) {
    return ipcRenderer.invoke("smithly:planning-session:ensure", scope, backlogItemId);
  },
  submitPlanningInput(scope, backlogItemId, bodyText) {
    return ipcRenderer.invoke("smithly:planning-session:submit", scope, backlogItemId, bodyText);
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

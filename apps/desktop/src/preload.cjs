const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smithlyDesktop", {
  getStatus() {
    return ipcRenderer.invoke("smithly:desktop-status");
  },
});

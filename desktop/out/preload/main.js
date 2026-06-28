"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("electronAPI", {
  openKbWindow: () => electron.ipcRenderer.send("open-kb-window")
});

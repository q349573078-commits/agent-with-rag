import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  openKbWindow: () => ipcRenderer.send("open-kb-window"),
});

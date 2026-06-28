"use strict";
const electron = require("electron");
const node_path = require("node:path");
const node_child_process = require("node:child_process");
let mainWindow = null;
let kbWindow = null;
let backendProcess = null;
function isUrl(url) {
  return typeof url === "string" && url.length > 0;
}
function createMainWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1e3,
    height: 750,
    minWidth: 600,
    minHeight: 500,
    title: "Agent",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/main.js"),
      sandbox: false
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Main window failed to load: ${errorDescription} (${errorCode}) URL: ${validatedURL}`);
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  console.log("Main window loading URL:", rendererUrl + "/main.html");
  if (isUrl(rendererUrl)) {
    mainWindow.loadURL(rendererUrl + "/main.html");
  } else {
    mainWindow.loadFile(node_path.join(__dirname, "../renderer/main/index.html"));
  }
}
function createKbWindow() {
  if (kbWindow && !kbWindow.isDestroyed()) {
    kbWindow.show();
    kbWindow.focus();
    return;
  }
  kbWindow = new electron.BrowserWindow({
    width: 500,
    height: 650,
    minWidth: 400,
    minHeight: 400,
    title: "Knowledge Base - Agent",
    webPreferences: {
      preload: node_path.join(__dirname, "../preload/kb.js"),
      sandbox: false
    }
  });
  kbWindow.on("close", (e) => {
    e.preventDefault();
    kbWindow?.hide();
  });
  kbWindow.on("closed", () => {
    kbWindow = null;
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (isUrl(rendererUrl)) {
    kbWindow.loadURL(rendererUrl + "/kb.html");
  } else {
    kbWindow.loadFile(node_path.join(__dirname, "../renderer/kb/index.html"));
  }
}
function startBackend() {
  const backendDir = node_path.resolve(electron.app.getAppPath(), "..", "backend");
  const useDev = !!process.env.ELECTRON_RENDERER_URL;
  if (useDev) {
    backendProcess = node_child_process.spawn("npx", ["tsx", "src/index.ts"], {
      cwd: backendDir,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true
    });
  } else {
    backendProcess = node_child_process.spawn("node", ["dist/index.js"], {
      cwd: backendDir,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true
    });
  }
  if (backendProcess.stdout) {
    backendProcess.stdout.on("data", (data) => {
      process.stdout.write(`[backend] ${data}`);
    });
    backendProcess.stdout.on("error", () => {
    });
  }
  if (backendProcess.stderr) {
    backendProcess.stderr.on("data", (data) => {
      process.stderr.write(`[backend] ${data}`);
    });
    backendProcess.stderr.on("error", () => {
    });
  }
  backendProcess.on("error", (err) => {
    console.error("[backend] Failed to start:", err.message);
  });
  backendProcess.on("exit", (code, signal) => {
    console.log(`[backend] exited (code=${code}, signal=${signal})`);
    backendProcess = null;
  });
}
function stopBackend() {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
    backendProcess = null;
  }
}
electron.app.whenReady().then(() => {
  startBackend();
  electron.ipcMain.on("open-kb-window", () => {
    createKbWindow();
  });
  createMainWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.app.on("before-quit", () => {
  stopBackend();
});

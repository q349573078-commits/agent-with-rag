import { app, BrowserWindow, ipcMain } from "electron";
import { join, resolve } from "node:path";
import { spawn, ChildProcess } from "node:child_process";

let mainWindow: BrowserWindow | null = null;
let kbWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;

function isUrl(url: string | undefined): url is string {
  return typeof url === "string" && url.length > 0;
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    minWidth: 600,
    minHeight: 500,
    title: "Agent",
    webPreferences: {
      preload: join(__dirname, "../preload/main.js"),
      sandbox: false,
    },
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
    mainWindow.loadFile(join(__dirname, "../renderer/main/index.html"));
  }
}

function createKbWindow(): void {
  if (kbWindow && !kbWindow.isDestroyed()) {
    kbWindow.show();
    kbWindow.focus();
    return;
  }

  kbWindow = new BrowserWindow({
    width: 500,
    height: 650,
    minWidth: 400,
    minHeight: 400,
    title: "Knowledge Base - Agent",
    webPreferences: {
      preload: join(__dirname, "../preload/kb.js"),
      sandbox: false,
    },
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
    kbWindow.loadFile(join(__dirname, "../renderer/kb/index.html"));
  }
}

function startBackend(): void {
  const backendDir = resolve(app.getAppPath(), "..", "backend");
  const useDev = !!process.env.ELECTRON_RENDERER_URL;

  if (useDev) {
    backendProcess = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: backendDir,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });
  } else {
    backendProcess = spawn("node", ["dist/index.js"], {
      cwd: backendDir,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });
  }

  if (backendProcess.stdout) {
    backendProcess.stdout.on("data", (data: Buffer) => {
      process.stdout.write(`[backend] ${data}`);
    });
    backendProcess.stdout.on("error", () => { });
  }

  if (backendProcess.stderr) {
    backendProcess.stderr.on("data", (data: Buffer) => {
      process.stderr.write(`[backend] ${data}`);
    });
    backendProcess.stderr.on("error", () => { });
  }

  backendProcess.on("error", (err) => {
    console.error("[backend] Failed to start:", err.message);
  });

  backendProcess.on("exit", (code, signal) => {
    console.log(`[backend] exited (code=${code}, signal=${signal})`);
    backendProcess = null;
  });
}

function stopBackend(): void {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
    backendProcess = null;
  }
}

app.whenReady().then(() => {
  startBackend();

  ipcMain.on("open-kb-window", () => {
    createKbWindow();
  });

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopBackend();
});

import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  startWorkspaceInput,
  stopWorkspaceInput,
  terminalResizeInput,
  terminalWriteInput,
} from "../shared/contracts.js";
import { IPC } from "../shared/ipc.js";
import { prepareIsolation } from "./isolation/prepare.js";
import {
  cleanupStaleWorkspaceRuntimes,
  cleanupWorkspaceRuntime,
  createWorkspaceRuntime,
} from "./runtime-directory.js";
import { TerminalManager } from "./terminal-manager.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

let mainWindow: BrowserWindow | null = null;
let workspaceRegistry: WorkspaceRegistry;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

const terminalManager = new TerminalManager({
  data: (event) => mainWindow?.webContents.send(IPC.terminalData, event),
  exit: (event) => mainWindow?.webContents.send(IPC.terminalExit, event),
});

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.listWorkspaces, () => workspaceRegistry.catalog());

  ipcMain.handle(IPC.startWorkspace, async (_event, input: unknown) => {
    const { workspaceId, targetId } = startWorkspaceInput.parse(input);
    const resolvedTarget = await workspaceRegistry.resolveTarget(
      workspaceId,
      targetId,
    );
    const sessionId = terminalManager.createSessionId();
    const runtime = await createWorkspaceRuntime(
      app.getPath("userData"),
      sessionId,
      resolvedTarget,
    );
    try {
      const isolation = await prepareIsolation(
        app.getAppPath(),
        runtime,
        resolvedTarget,
      );
      return await terminalManager.startWorkspace(
        sessionId,
        resolvedTarget,
        runtime,
        isolation,
      );
    } catch (error) {
      await cleanupWorkspaceRuntime(runtime);
      throw error;
    }
  });

  ipcMain.handle(IPC.terminalWrite, (_event, input: unknown) => {
    const { sessionId, terminalId, data } = terminalWriteInput.parse(input);
    terminalManager.write(sessionId, terminalId, data);
  });

  ipcMain.handle(IPC.terminalResize, (_event, input: unknown) => {
    const { sessionId, terminalId, cols, rows } = terminalResizeInput.parse(input);
    terminalManager.resize(sessionId, terminalId, cols, rows);
  });

  ipcMain.handle(IPC.stopWorkspace, async (_event, input: unknown) => {
    const { sessionId } = stopWorkspaceInput.parse(input);
    await terminalManager.stopSession(sessionId);
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 650,
    backgroundColor: "#0b1117",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("closed", () => {
    void terminalManager.stopAll();
    mainWindow = null;
  });

  const developmentUrl = process.env.OPSCAPSULE_DEV_SERVER_URL;
  if (developmentUrl) {
    await mainWindow.loadURL(developmentUrl);
  } else {
    await mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }
  await cleanupStaleWorkspaceRuntimes(app.getPath("userData"));
  workspaceRegistry = new WorkspaceRegistry(app.getPath("userData"));
  await workspaceRegistry.initialize();
  registerIpcHandlers();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
});

app.on("before-quit", () => void terminalManager.stopAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

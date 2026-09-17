import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  startWorkspaceInput,
  stopWorkspaceInput,
  terminalResizeInput,
  terminalWriteInput,
} from "../shared/contracts.js";
import { IPC } from "../shared/ipc.js";
import { createWorkspaceRuntime } from "./runtime-directory.js";
import { TerminalManager } from "./terminal-manager.js";
import { getWorkspace, WORKSPACES } from "./workspaces.js";

let mainWindow: BrowserWindow | null = null;

const terminalManager = new TerminalManager({
  data: (event) => mainWindow?.webContents.send(IPC.terminalData, event),
  exit: (event) => mainWindow?.webContents.send(IPC.terminalExit, event),
});

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.listWorkspaces, () => WORKSPACES);

  ipcMain.handle(IPC.startWorkspace, async (_event, input: unknown) => {
    const { workspaceId } = startWorkspaceInput.parse(input);
    const workspace = getWorkspace(workspaceId);
    const runtime = await createWorkspaceRuntime(app.getPath("userData"), workspace);
    return terminalManager.startWorkspace(workspace, runtime);
  });

  ipcMain.handle(IPC.terminalWrite, (_event, input: unknown) => {
    const { sessionId, terminalId, data } = terminalWriteInput.parse(input);
    terminalManager.write(sessionId, terminalId, data);
  });

  ipcMain.handle(IPC.terminalResize, (_event, input: unknown) => {
    const { sessionId, terminalId, cols, rows } = terminalResizeInput.parse(input);
    terminalManager.resize(sessionId, terminalId, cols, rows);
  });

  ipcMain.handle(IPC.stopWorkspace, (_event, input: unknown) => {
    const { sessionId } = stopWorkspaceInput.parse(input);
    terminalManager.stopSession(sessionId);
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
    terminalManager.stopAll();
    mainWindow = null;
  });

  const developmentUrl = process.env.OPSCAPSULE_DEV_SERVER_URL;
  if (developmentUrl) {
    await mainWindow.loadURL(developmentUrl);
  } else {
    await mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
  }
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("before-quit", () => terminalManager.stopAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});


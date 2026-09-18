import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
  choosePathInput,
  createWorkspaceInput,
  inspectDirectoryInput,
  saveWorkspaceInput,
  startWorkspaceInput,
  stopWorkspaceInput,
  terminalAttachmentInput,
  terminalResizeInput,
  terminalWriteInput,
  workspaceDocumentInput,
} from "../shared/contracts.js";
import { IPC } from "../shared/ipc.js";
import { createExecutionHost } from "./hosts/index.js";
import type { ExecutionHost } from "./hosts/types.js";
import { TerminalManager } from "./terminal-manager.js";
import { WorkspaceRegistry } from "./workspace-registry.js";
import { discoverLocalResources } from "./local-resources.js";

let mainWindow: BrowserWindow | null = null;
let workspaceRegistry: WorkspaceRegistry;
let terminalManager: TerminalManager | null = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function registerIpcHandlers(host: ExecutionHost, terminals: TerminalManager): void {
  ipcMain.handle(IPC.listWorkspaces, () => workspaceRegistry.catalog());

  ipcMain.handle(IPC.getWorkspace, (_event, input: unknown) => {
    const { workspaceId } = workspaceDocumentInput.parse(input);
    return workspaceRegistry.document(workspaceId);
  });

  ipcMain.handle(IPC.createWorkspace, (_event, input: unknown) => {
    const { manifest } = createWorkspaceInput.parse(input);
    return workspaceRegistry.create(manifest);
  });

  ipcMain.handle(IPC.saveWorkspace, (_event, input: unknown) => {
    const { workspaceId, revision, manifest } = saveWorkspaceInput.parse(input);
    return workspaceRegistry.save(workspaceId, revision, manifest);
  });

  ipcMain.handle(IPC.choosePath, async (_event, input: unknown) => {
    const { kind } = choosePathInput.parse(input);
    const options: Electron.OpenDialogOptions = {
      properties: [kind === "directory" ? "openDirectory" : "openFile"],
      ...(process.platform === "darwin" ? { showHiddenFiles: true } : {}),
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const selected = result.canceled ? null : (result.filePaths[0] ?? null);
    // Directories are used by capsule processes on the execution host; files
    // (kubeconfig, AWS config) are read by this process when saving.
    return selected && kind === "directory"
      ? host.translateHostPath(selected)
      : selected;
  });

  ipcMain.handle(IPC.inspectDirectory, (_event, input: unknown) => {
    const { path } = inspectDirectoryInput.parse(input);
    return host.inspectDirectory(path);
  });

  ipcMain.handle(IPC.discoverLocalResources, () => discoverLocalResources());

  ipcMain.handle(IPC.startWorkspace, async (_event, input: unknown) => {
    const { workspaceId, targetId } = startWorkspaceInput.parse(input);
    const resolvedTarget = await workspaceRegistry.resolveTarget(
      workspaceId,
      targetId,
    );
    const sessionId = terminals.createSessionId();
    const capsule = await host.createRuntime(sessionId, resolvedTarget);
    try {
      const isolation = await host.prepareIsolation(
        capsule.runtime,
        resolvedTarget,
      );
      return await terminals.startWorkspace(
        sessionId,
        resolvedTarget,
        capsule,
        isolation,
      );
    } catch (error) {
      await host.cleanupRuntime(capsule.runtime);
      throw error;
    }
  });

  ipcMain.handle(IPC.terminalWrite, (_event, input: unknown) => {
    const { sessionId, terminalId, data } = terminalWriteInput.parse(input);
    terminals.write(sessionId, terminalId, data);
  });

  ipcMain.handle(IPC.terminalAttach, (_event, input: unknown) => {
    const { sessionId, terminalId } = terminalAttachmentInput.parse(input);
    terminals.attach(sessionId, terminalId);
  });

  ipcMain.handle(IPC.terminalResize, (_event, input: unknown) => {
    const { sessionId, terminalId, cols, rows } = terminalResizeInput.parse(input);
    terminals.resize(sessionId, terminalId, cols, rows);
  });

  ipcMain.handle(IPC.stopWorkspace, async (_event, input: unknown) => {
    const { sessionId } = stopWorkspaceInput.parse(input);
    await terminals.stopSession(sessionId);
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
    void terminalManager?.stopAll();
    mainWindow = null;
  });

  const developmentUrl = process.env.OPSCAPSULE_DEV_SERVER_URL;
  if (developmentUrl) {
    await mainWindow.loadURL(developmentUrl);
  } else {
    await mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
  }
}

async function initializeExecutionHost(): Promise<ExecutionHost> {
  try {
    return await createExecutionHost({
      userDataDirectory: app.getPath("userData"),
      applicationRoot: app.getAppPath(),
    });
  } catch (error) {
    dialog.showErrorBox(
      "OpsCapsule cannot start",
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
    throw error;
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }
  const host = await initializeExecutionHost();
  await host.cleanupStaleRuntimes();
  workspaceRegistry = new WorkspaceRegistry(app.getPath("userData"), {
    paths: host.paths,
    demoRoot: host.path.join(host.stateDirectory, "demo-workspaces"),
    createDemoDirectories: (directories) =>
      host.createDemoDirectories(directories),
  });
  await workspaceRegistry.initialize();
  terminalManager = new TerminalManager(host, {
    data: (event) => mainWindow?.webContents.send(IPC.terminalData, event),
    exit: (event) => mainWindow?.webContents.send(IPC.terminalExit, event),
  });
  registerIpcHandlers(host, terminalManager);
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

app.on("before-quit", () => void terminalManager?.stopAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

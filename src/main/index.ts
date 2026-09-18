import { isAbsolute, join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import {
  choosePathInput,
  createWorkspaceInput,
  deleteWorkspaceInput,
  inspectDirectoryInput,
  inspectAgentConfigurationInput,
  saveWorkspaceInput,
  startWorkspaceInput,
  stopWorkspaceInput,
  terminalAttachmentInput,
  terminalResizeInput,
  terminalWriteInput,
  workspaceDocumentInput,
} from "../shared/contracts.js";
import { IPC } from "../shared/ipc.js";
import { prepareIsolation } from "./isolation/prepare.js";
import {
  cleanupStaleWorkspaceRuntimes,
  cleanupWorkspaceRuntime,
  createWorkspaceRuntime,
} from "./runtime-directory.js";
import { TerminalManager } from "./terminal-manager.js";
import { checkTargetReadiness } from "./target-readiness.js";
import { WorkspaceRegistry } from "./workspace-registry.js";
import {
  discoverLocalResources,
  inspectAgentConfigurationFile,
  inspectDirectory,
} from "./local-resources.js";

app.setName("OpsCapsule");

let mainWindow: BrowserWindow | null = null;
let workspaceRegistry: WorkspaceRegistry;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

const terminalManager = new TerminalManager({
  data: (event) => mainWindow?.webContents.send(IPC.terminalData, event),
  exit: (event) => mainWindow?.webContents.send(IPC.terminalExit, event),
});

function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    return;
  }

  const applicationName = app.getName();
  const template: MenuItemConstructorOptions[] = [
    {
      label: applicationName,
      submenu: [
        { label: `About ${applicationName}`, role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { label: `Hide ${applicationName}`, role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: `Quit ${applicationName}`, role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers(): void {
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

  ipcMain.handle(IPC.deleteWorkspace, async (_event, input: unknown) => {
    const { workspaceId, revision } = deleteWorkspaceInput.parse(input);
    if (terminalManager.hasActiveWorkspace(workspaceId)) {
      throw new Error("Stop every capsule in this workspace before deleting it");
    }
    await workspaceRegistry.deleteWorkspace(workspaceId, revision);
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
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.inspectDirectory, (_event, input: unknown) => {
    const { path } = inspectDirectoryInput.parse(input);
    return inspectDirectory(path);
  });

  ipcMain.handle(IPC.inspectAgentConfiguration, async (_event, input: unknown) => {
    const { path, workspaceId } = inspectAgentConfigurationInput.parse(input);
    let resolvedPath = path;
    if (!isAbsolute(path)) {
      if (!workspaceId) {
        throw new Error("A workspace id is required for a managed relative path");
      }
      resolvedPath = await workspaceRegistry.resolveAgentConfigurationPath(
        workspaceId,
        path,
      );
    }
    return inspectAgentConfigurationFile(resolvedPath);
  });

  ipcMain.handle(IPC.discoverLocalResources, () => discoverLocalResources());

  ipcMain.handle(IPC.checkTargetReadiness, async (_event, input: unknown) => {
    const { workspaceId, targetId } = startWorkspaceInput.parse(input);
    return checkTargetReadiness(
      await workspaceRegistry.resolveTarget(workspaceId, targetId),
    );
  });

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

  ipcMain.handle(IPC.terminalAttach, (_event, input: unknown) => {
    const { sessionId, terminalId } = terminalAttachmentInput.parse(input);
    terminalManager.attach(sessionId, terminalId);
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
  const applicationIcon = join(
    app.getAppPath(),
    "assets",
    "icons",
    "png",
    "256x256.png",
  );
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1000,
    minHeight: 650,
    backgroundColor: "#0b1117",
    icon: applicationIcon,
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
  if (process.platform === "darwin") {
    app.dock?.setIcon(
      join(app.getAppPath(), "assets", "icons", "png", "256x256.png"),
    );
  }
  installApplicationMenu();
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

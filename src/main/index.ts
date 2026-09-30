import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  nativeTheme,
  protocol,
  safeStorage,
  shell,
  utilityProcess,
} from "electron";
import {
  choosePathInput,
  createWorkspaceInput,
  credentialAuthenticateInput,
  credentialForgetInput,
  credentialImportInput,
  credentialOverviewInput,
  credentialStatusInput,
  openExternalInput,
  savePreferencesInput,
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
import { installApplicationMenu } from "./application-menu.js";
import { PreferencesStore } from "./preferences.js";
import {
  preferencesSchema,
  resolveTheme,
} from "../shared/preferences.js";
import { prepareIsolation } from "./isolation/prepare.js";
import { CredentialBrokerSession } from "./credentials/broker.js";
import { createBrokerToken } from "./credentials/helper.js";
import { createCredentialIssuer } from "./credentials/issuer.js";
import { CredentialStore, scopeContext } from "./credentials/store.js";
import { readAgentLogin } from "./credentials/agent-logins.js";
import { ssoLogin } from "./credentials/aws-profile.js";
import {
  assertUsableSecret,
  credentialOverview,
  credentialStatuses,
  sharedCredentialReferences,
  readSecretFromFile,
  requireReference,
  storageContextFor,
} from "./credentials/service.js";
import type { PreferencesState } from "../shared/contracts.js";
import type { CapsuleBroker } from "./terminal-manager.js";
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
import { verifyPackagedTerminalWorker } from "./packaged-smoke.js";
import {
  RENDERER_SCHEME,
  RENDERER_URL,
  resolveRendererAssetPath,
} from "./renderer-protocol.js";

app.setName("OpsCapsule");
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  },
]);

const isPackagedSmokeTest = process.env.OPSCAPSULE_PACKAGED_SMOKE_TEST === "1";
const smokeUserData = process.env.OPSCAPSULE_SMOKE_USER_DATA;
if (isPackagedSmokeTest && smokeUserData) {
  app.setPath("userData", smokeUserData);
}

let mainWindow: BrowserWindow | null = null;
let workspaceRegistry: WorkspaceRegistry;
const hasSingleInstanceLock =
  isPackagedSmokeTest || app.requestSingleInstanceLock();

const terminalManager = new TerminalManager({
  events: {
    data: (event) => mainWindow?.webContents.send(IPC.terminalData, event),
    exit: (event) => mainWindow?.webContents.send(IPC.terminalExit, event),
  },
  forkWorker: (workerPath, options) =>
    utilityProcess.fork(workerPath, [], options),
  workerPath: join(__dirname, "terminal-worker.cjs"),
});

function registerRendererProtocol(): void {
  const rendererRoot = join(__dirname, "renderer");
  protocol.handle(RENDERER_SCHEME, (request) => {
    const assetPath = resolveRendererAssetPath(request.url, rendererRoot);
    if (!assetPath) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(assetPath).toString());
  });
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
      throw new Error(
        "Stop every capsule in this workspace before deleting it",
      );
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

  ipcMain.handle(
    IPC.inspectAgentConfiguration,
    async (_event, input: unknown) => {
      const { path, workspaceId } = inspectAgentConfigurationInput.parse(input);
      let resolvedPath = path;
      if (!isAbsolute(path)) {
        if (!workspaceId) {
          throw new Error(
            "A workspace id is required for a managed relative path",
          );
        }
        resolvedPath = await workspaceRegistry.resolveAgentConfigurationPath(
          workspaceId,
          path,
        );
      }
      return inspectAgentConfigurationFile(resolvedPath);
    },
  );

  ipcMain.handle(IPC.discoverLocalResources, () => discoverLocalResources());

  const preferencesStore = new PreferencesStore(app.getPath("userData"));

  const preferencesState = async (): Promise<PreferencesState> => {
    const preferences = await preferencesStore.read();
    return {
      preferences,
      resolvedTheme: resolveTheme(
        preferences.theme,
        nativeTheme.shouldUseDarkColors,
      ),
    };
  };

  ipcMain.handle(IPC.getPreferences, async () => {
    // Applying the stored preference to nativeTheme keeps the native chrome,
    // such as the title bar and system dialogs, in step with the window.
    const { preferences } = await preferencesState();
    nativeTheme.themeSource = preferences.theme;
    return preferencesState();
  });

  ipcMain.handle(IPC.savePreferences, async (_event, input: unknown) => {
    const { preferences } = savePreferencesInput.parse(input);
    const saved = await preferencesStore.write(preferencesSchema.parse(preferences));
    nativeTheme.themeSource = saved.theme;
    return preferencesState();
  });

  // Following the system means reacting to it, not only reading it at launch.
  nativeTheme.on("updated", () => {
    void preferencesState().then((state) => {
      mainWindow?.webContents.send(IPC.themeChanged, state);
    });
  });

  ipcMain.handle(IPC.openExternal, async (_event, input: unknown) => {
    const { url } = openExternalInput.parse(input);
    // The renderer is not trusted to have validated this, and a manifest is
    // editable and shareable. Anything but http or https would turn a pinned
    // link into a way to run something on the machine.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("That link is not a valid URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http and https links can be opened.");
    }
    await shell.openExternal(parsed.toString());
  });

  const credentialStoreFor = () =>
    new CredentialStore(app.getPath("userData"), safeStorage);

  ipcMain.handle(IPC.checkTargetReadiness, async (_event, input: unknown) => {
    const { workspaceId, targetId } = startWorkspaceInput.parse(input);
    const resolvedTarget = await workspaceRegistry.resolveTarget(
      workspaceId,
      targetId,
    );
    const store = credentialStoreFor();
    return checkTargetReadiness(
      resolvedTarget,
      undefined,
      (reference) =>
        store.has(
          reference,
          scopeContext(reference.scope, {
            workspaceId,
            targetId,
          }),
        ),
    );
  });

  ipcMain.handle(IPC.credentialStatus, async (_event, input: unknown) => {
    const { workspaceId } = credentialStatusInput.parse(input);
    const { manifest } = await workspaceRegistry.document(workspaceId);
    return credentialStatuses(credentialStoreFor(), manifest);
  });

  ipcMain.handle(IPC.credentialOverview, async (_event, input: unknown) => {
    const selected = credentialOverviewInput.parse(input);
    const { workspaces } = await workspaceRegistry.catalog();
    const manifests = await Promise.all(
      workspaces.map(async ({ id }) => (await workspaceRegistry.document(id)).manifest),
    );
    return credentialOverview(credentialStoreFor(), manifests, selected);
  });

  ipcMain.handle(IPC.credentialShared, async () => {
    const { workspaces } = await workspaceRegistry.catalog();
    const manifests = await Promise.all(
      workspaces.map(async ({ id }) => (await workspaceRegistry.document(id)).manifest),
    );
    return sharedCredentialReferences(manifests);
  });

  ipcMain.handle(IPC.credentialImport, async (_event, input: unknown) => {
    const request = credentialImportInput.parse(input);
    const { manifest } = await workspaceRegistry.document(request.workspaceId);
    const reference = requireReference(manifest, request.referenceId);

    // A provider login is taken from the agent's own store on the host, so the
    // user selects a login rather than hunting for a file, and only the
    // selected entry is imported instead of every provider they have used.
    const secret = request.sourcePath
      ? await readSecretFromFile(request.sourcePath)
      : (request.secret ??
        (reference.kind === "provider-oauth" && reference.sourceProfile
          ? await readAgentLogin(
              reference.providerId ?? "",
              reference.sourceProfile,
            )
          : undefined));
    if (!secret) {
      throw new Error("No credential was supplied.");
    }
    assertUsableSecret(reference, secret);

    const store = credentialStoreFor();
    await store.write(
      reference,
      secret,
      scopeContext(
        reference.scope,
        storageContextFor(manifest, reference, request.targetId),
      ),
    );
    // Only status returns to the renderer; the secret never does.
    return credentialStatuses(store, manifest);
  });

  ipcMain.handle(IPC.credentialAuthenticate, async (_event, input: unknown) => {
    const request = credentialAuthenticateInput.parse(input);
    const { manifest } = await workspaceRegistry.document(request.workspaceId);
    const reference = requireReference(manifest, request.referenceId);
    if (reference.kind !== "aws-profile") {
      throw new Error(
        `'${reference.name}' is authenticated by importing a credential, not by signing in.`,
      );
    }
    if (!reference.sourceProfile) {
      throw new Error(`Select an AWS profile for '${reference.name}' first.`);
    }
    await ssoLogin(reference.sourceProfile);
    return credentialStatuses(credentialStoreFor(), manifest);
  });

  ipcMain.handle(IPC.credentialForget, async (_event, input: unknown) => {
    const request = credentialForgetInput.parse(input);
    const { manifest } = await workspaceRegistry.document(request.workspaceId);
    const reference = requireReference(manifest, request.referenceId);
    const store = credentialStoreFor();
    await store.forget(
      reference,
      scopeContext(
        reference.scope,
        storageContextFor(manifest, reference, request.targetId),
      ),
    );
    return credentialStatuses(store, manifest);
  });

  ipcMain.handle(IPC.startWorkspace, async (_event, input: unknown) => {
    const { workspaceId, targetId } = startWorkspaceInput.parse(input);
    const resolvedTarget = await workspaceRegistry.resolveTarget(
      workspaceId,
      targetId,
    );
    const sessionId = terminalManager.createSessionId();
    const credentialStore = new CredentialStore(
      app.getPath("userData"),
      safeStorage,
    );
    const credentialContext = {
      workspaceId: resolvedTarget.workspace.manifest.metadata.id,
      targetId: resolvedTarget.target.id,
    };
    const runtime = await createWorkspaceRuntime(
      app.getPath("userData"),
      sessionId,
      resolvedTarget,
      (reference) =>
        credentialStore.read(
          reference,
          scopeContext(reference.scope, credentialContext),
        ),
    );
    let broker: CredentialBrokerSession | undefined;
    try {
      const isolation = await prepareIsolation(runtime, resolvedTarget);

      const references = [
        resolvedTarget.credentials.operational,
        resolvedTarget.credentials.inference,
      ].filter((reference) => reference !== undefined);

      let brokerHandle: CapsuleBroker | undefined;
      if (runtime.brokerSocket && references.length > 0) {
        const token = createBrokerToken();
        broker = new CredentialBrokerSession({
          socketPath: runtime.brokerSocket,
          token,
          references,
          issue: createCredentialIssuer(credentialStore, credentialContext),
        });
        await broker.listen();
        const session = broker;
        brokerHandle = { token, close: () => session.close() };
      }

      return await terminalManager.startWorkspace(
        sessionId,
        resolvedTarget,
        runtime,
        isolation,
        brokerHandle,
      );
    } catch (error) {
      await broker?.close();
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
    const { sessionId, terminalId, cols, rows } =
      terminalResizeInput.parse(input);
    terminalManager.resize(sessionId, terminalId, cols, rows);
  });

  ipcMain.handle(IPC.stopWorkspace, async (_event, input: unknown) => {
    const { sessionId } = stopWorkspaceInput.parse(input);
    await terminalManager.stopSession(sessionId);
  });
}

/** Matches --bg-1 in each theme, so the window does not flash the wrong colour. */
const windowBackground = { dark: "#0d161c", light: "#e7eef4" } as const;

async function createWindow(show = true): Promise<void> {
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
    show,
    backgroundColor:
      windowBackground[
        resolveTheme(
          (await new PreferencesStore(app.getPath("userData")).read()).theme,
          nativeTheme.shouldUseDarkColors,
        )
      ],
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
    await mainWindow.loadURL(RENDERER_URL);
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
}

void app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) {
      return;
    }
    await cleanupStaleWorkspaceRuntimes(app.getPath("userData"));
    registerRendererProtocol();
    if (process.platform === "darwin") {
      app.dock?.setIcon(
        join(app.getAppPath(), "assets", "icons", "png", "256x256.png"),
      );
    }
    workspaceRegistry = new WorkspaceRegistry(app.getPath("userData"));
    await workspaceRegistry.initialize();
    registerIpcHandlers();
    installApplicationMenu(() => mainWindow);
    await createWindow(!isPackagedSmokeTest);

    if (isPackagedSmokeTest) {
      await verifyPackagedTerminalWorker(
        join(__dirname, "terminal-worker.cjs"),
        app.getPath("temp"),
      );
      console.log("OpsCapsule packaged application verification passed.");
      mainWindow?.destroy();
      app.quit();
      return;
    }

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
  })
  .catch((error: unknown) => {
    console.error("OpsCapsule failed to start:", error);
    app.exit(1);
  });

app.on("before-quit", () => void terminalManager.stopAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

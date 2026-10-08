import { contextBridge, ipcRenderer } from "electron";
import type {
  OpsCapsuleApi,
  TerminalDataEvent,
  TerminalExitEvent,
} from "../shared/contracts.js";
import { IPC } from "../shared/ipc.js";
import type { PreferencesState } from "../shared/contracts.js";

const api: OpsCapsuleApi = {
  listWorkspaces: () => ipcRenderer.invoke(IPC.listWorkspaces),
  getWorkspace: (workspaceId) =>
    ipcRenderer.invoke(IPC.getWorkspace, { workspaceId }),
  createWorkspace: (manifest) =>
    ipcRenderer.invoke(IPC.createWorkspace, { manifest }),
  saveWorkspace: (workspaceId, revision, manifest) =>
    ipcRenderer.invoke(IPC.saveWorkspace, {
      workspaceId,
      revision,
      manifest,
    }),
  deleteWorkspace: (workspaceId, revision) =>
    ipcRenderer.invoke(IPC.deleteWorkspace, { workspaceId, revision }),
  choosePath: (kind) => ipcRenderer.invoke(IPC.choosePath, { kind }),
  inspectDirectory: (path) =>
    ipcRenderer.invoke(IPC.inspectDirectory, { path }),
  discoverPathAliases: (path) =>
    ipcRenderer.invoke(IPC.discoverPathAliases, { path }),
  inspectAgentConfiguration: (path, workspaceId) =>
    ipcRenderer.invoke(IPC.inspectAgentConfiguration, { path, workspaceId }),
  discoverLocalResources: () =>
    ipcRenderer.invoke(IPC.discoverLocalResources),
  credentialStatus: (workspaceId) =>
    ipcRenderer.invoke(IPC.credentialStatus, { workspaceId }),
  credentialOverview: (input) =>
    ipcRenderer.invoke(IPC.credentialOverview, input),
  sharedCredentials: () => ipcRenderer.invoke(IPC.credentialShared),
  importCredential: (input) => ipcRenderer.invoke(IPC.credentialImport, input),
  authenticateCredential: (input) =>
    ipcRenderer.invoke(IPC.credentialAuthenticate, input),
  forgetCredential: (input) => ipcRenderer.invoke(IPC.credentialForget, input),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, { url }),
  getPreferences: () => ipcRenderer.invoke(IPC.getPreferences),
  savePreferences: (preferences) =>
    ipcRenderer.invoke(IPC.savePreferences, { preferences }),
  onOpenPreferences: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.openPreferences, handler);
    return () => ipcRenderer.removeListener(IPC.openPreferences, handler);
  },
  onThemeChanged: (listener) => {
    const handler = (_event: unknown, state: PreferencesState) => listener(state);
    ipcRenderer.on(IPC.themeChanged, handler);
    return () => ipcRenderer.removeListener(IPC.themeChanged, handler);
  },
  checkTargetReadiness: (workspaceId, targetId) =>
    ipcRenderer.invoke(IPC.checkTargetReadiness, { workspaceId, targetId }),
  startWorkspace: (workspaceId, targetId) =>
    ipcRenderer.invoke(IPC.startWorkspace, { workspaceId, targetId }),
  attachTerminal: (sessionId, terminalId) =>
    ipcRenderer.invoke(IPC.terminalAttach, { sessionId, terminalId }),
  writeTerminal: (sessionId, terminalId, data) =>
    ipcRenderer.invoke(IPC.terminalWrite, { sessionId, terminalId, data }),
  resizeTerminal: (sessionId, terminalId, cols, rows) =>
    ipcRenderer.invoke(IPC.terminalResize, {
      sessionId,
      terminalId,
      cols,
      rows,
    }),
  stopWorkspace: (sessionId) =>
    ipcRenderer.invoke(IPC.stopWorkspace, { sessionId }),
  onTerminalData: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TerminalDataEvent) =>
      listener(data);
    ipcRenderer.on(IPC.terminalData, handler);
    return () => ipcRenderer.removeListener(IPC.terminalData, handler);
  },
  onTerminalExit: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TerminalExitEvent) =>
      listener(data);
    ipcRenderer.on(IPC.terminalExit, handler);
    return () => ipcRenderer.removeListener(IPC.terminalExit, handler);
  },
};

contextBridge.exposeInMainWorld("opsCapsule", Object.freeze(api));

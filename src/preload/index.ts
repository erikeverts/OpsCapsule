import { contextBridge, ipcRenderer } from "electron";
import type {
  OpsCapsuleApi,
  TerminalDataEvent,
  TerminalExitEvent,
} from "../shared/contracts.js";
import { IPC } from "../shared/ipc.js";

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
  inspectAgentConfiguration: (path, workspaceId) =>
    ipcRenderer.invoke(IPC.inspectAgentConfiguration, { path, workspaceId }),
  discoverLocalResources: () =>
    ipcRenderer.invoke(IPC.discoverLocalResources),
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

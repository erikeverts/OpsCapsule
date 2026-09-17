export const IPC = {
  listWorkspaces: "workspace:list",
  getWorkspace: "workspace:get",
  createWorkspace: "workspace:create",
  saveWorkspace: "workspace:save",
  choosePath: "workspace:choose-path",
  startWorkspace: "workspace:start",
  stopWorkspace: "workspace:stop",
  terminalAttach: "terminal:attach",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
} as const;

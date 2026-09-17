export const IPC = {
  listWorkspaces: "workspace:list",
  startWorkspace: "workspace:start",
  stopWorkspace: "workspace:stop",
  terminalAttach: "terminal:attach",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
} as const;

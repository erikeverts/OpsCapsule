import { z } from "zod";

export type PaneKind = "agent" | "shell";

export interface CommandRuntimeDefinition {
  adapter: "command";
  command: string;
  args: string[];
}

export interface WorkspaceDefinition {
  id: string;
  name: string;
  environment: string;
  awsProfile: string;
  accountId: string;
  region: string;
  cluster: string;
  namespace: string;
  agentRuntime: CommandRuntimeDefinition;
}

export interface RuntimePaths {
  root: string;
  kubeconfig: string;
}

export interface TerminalDescriptor {
  id: string;
  title: string;
  kind: PaneKind;
}

export interface WorkspaceSession {
  id: string;
  workspace: WorkspaceDefinition;
  runtime: RuntimePaths;
  terminals: TerminalDescriptor[];
}

export interface TerminalDataEvent {
  sessionId: string;
  terminalId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  terminalId: string;
  exitCode: number;
}

export const startWorkspaceInput = z.object({
  workspaceId: z.string().min(1),
});

export const terminalWriteInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  data: z.string(),
});

export const terminalResizeInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
});

export const stopWorkspaceInput = z.object({
  sessionId: z.string().min(1),
});

export interface OpsCapsuleApi {
  listWorkspaces(): Promise<WorkspaceDefinition[]>;
  startWorkspace(workspaceId: string): Promise<WorkspaceSession>;
  writeTerminal(sessionId: string, terminalId: string, data: string): Promise<void>;
  resizeTerminal(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void>;
  stopWorkspace(sessionId: string): Promise<void>;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void;
}


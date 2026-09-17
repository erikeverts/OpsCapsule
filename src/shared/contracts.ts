import { z } from "zod";
import type { WorkspaceManifest } from "./workspace-schema.js";

export type PaneKind = "agent" | "shell";
export type DirectoryAccess = "read-only" | "read-write";
export type IsolationMode = "enforced" | "context-only";
export type NetworkMode = "public" | "deny" | "allowlist";

export interface CommandRuntimeDefinition {
  adapter: "command";
  command: string;
  args: string[];
}

export interface DirectorySummary {
  id: string;
  name: string;
  path: string;
  access: DirectoryAccess;
}

export interface CloudConnectionSummary {
  id: string;
  name: string;
  provider: string;
  identity?: string;
  location?: string;
}

export interface KubernetesContextSummary {
  id: string;
  name: string;
  context: string;
  namespace?: string;
}

export interface WorkspaceTargetSummary {
  id: string;
  name: string;
  environment: string;
  risk: "development" | "staging" | "production";
  cloud?: CloudConnectionSummary;
  kubernetes?: KubernetesContextSummary;
  directories: DirectorySummary[];
  defaultDirectory: string;
  agentRuntime: CommandRuntimeDefinition;
  isolationMode: IsolationMode;
  networkMode: NetworkMode;
}

export interface WorkspaceCatalogEntry {
  id: string;
  name: string;
  description?: string;
  sourcePath: string;
  targets: WorkspaceTargetSummary[];
}

export interface WorkspaceLoadError {
  sourcePath: string;
  message: string;
}

export interface WorkspaceCatalog {
  configDirectory: string;
  workspaces: WorkspaceCatalogEntry[];
  errors: WorkspaceLoadError[];
}

export interface WorkspaceDocument {
  manifest: WorkspaceManifest;
  sourcePath: string;
  revision: string;
  yaml: string;
}

export interface RuntimePaths {
  root: string;
  home: string;
  temp: string;
  kubeconfig: string;
  sandboxConfig: string;
}

export interface EffectiveIsolation {
  mode: IsolationMode;
  backend: "sandbox-runtime" | "none";
  readOnlyPaths: string[];
  readWritePaths: string[];
  networkMode: NetworkMode;
}

export interface TerminalDescriptor {
  id: string;
  title: string;
  kind: PaneKind;
}

export interface WorkspaceSession {
  id: string;
  workspace: Pick<WorkspaceCatalogEntry, "id" | "name">;
  target: WorkspaceTargetSummary;
  runtime: RuntimePaths;
  isolation: EffectiveIsolation;
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
  targetId: z.string().min(1),
});

export const workspaceDocumentInput = z.object({
  workspaceId: z.string().min(1),
});

export const createWorkspaceInput = z.object({
  manifest: z.unknown(),
});

export const saveWorkspaceInput = z.object({
  workspaceId: z.string().min(1),
  revision: z.string().min(1),
  manifest: z.unknown(),
});

export const choosePathInput = z.object({
  kind: z.enum(["directory", "file"]),
});

export const terminalWriteInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  data: z.string(),
});

export const terminalAttachmentInput = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
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
  listWorkspaces(): Promise<WorkspaceCatalog>;
  getWorkspace(workspaceId: string): Promise<WorkspaceDocument>;
  createWorkspace(manifest: WorkspaceManifest): Promise<WorkspaceDocument>;
  saveWorkspace(
    workspaceId: string,
    revision: string,
    manifest: WorkspaceManifest,
  ): Promise<WorkspaceDocument>;
  choosePath(kind: "directory" | "file"): Promise<string | null>;
  startWorkspace(
    workspaceId: string,
    targetId: string,
  ): Promise<WorkspaceSession>;
  attachTerminal(sessionId: string, terminalId: string): Promise<void>;
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

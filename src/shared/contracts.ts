import { z } from "zod";
import type { CredentialStatus } from "./credentials.js";
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

export interface AgentProfileSummary {
  id: string;
  name: string;
  adapter: string;
  command: string;
  legacy: boolean;
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
  agent: AgentProfileSummary;
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

export interface VersionControlSummary {
  type: "git" | "subversion" | "cvs" | "mercurial";
  root: string;
}

export interface DirectoryInspection {
  path: string;
  versionControl?: VersionControlSummary;
}

export interface AwsProfileOption {
  name: string;
  configFile: string;
  region?: string;
  accountId?: string;
}

export interface KubernetesContextOption {
  name: string;
  path: string;
  cluster?: string;
  namespace?: string;
  current: boolean;
}

export interface AgentConfigurationFileOption {
  adapter: "opencode" | "claude-code";
  name: string;
  path: string;
  destination: string;
  warnings: AgentConfigurationWarning[];
}

export type AgentConfigurationWarningCategory =
  | "identity"
  | "credentials"
  | "hooks"
  | "plugins"
  | "mcp"
  | "unparsed";

export interface AgentConfigurationWarning {
  category: AgentConfigurationWarningCategory;
  severity: "warning" | "danger";
  message: string;
}

export interface AgentConfigurationInspection {
  path: string;
  warnings: AgentConfigurationWarning[];
}

export interface LocalResourceOptions {
  awsProfiles: AwsProfileOption[];
  kubernetesContexts: KubernetesContextOption[];
  agentConfigurationFiles: AgentConfigurationFileOption[];
}

export interface RuntimePaths {
  root: string;
  home: string;
  temp: string;
  kubeconfig: string;
  sandboxConfig: string;
  targetState: string;
  agentState: string;
  agentInstructions?: string;
  /**
   * Present only when this capsule brokers credentials. Paths only; no
   * credential value ever crosses the IPC boundary.
   */
  brokerSocket?: string;
  brokerHelper?: string;
}

export type ReadinessCheckStatus = "pass" | "warning" | "fail";

export interface TargetReadinessCheck {
  id: string;
  label: string;
  status: ReadinessCheckStatus;
  detail: string;
  details?: string[];
}

export interface TargetReadinessReport {
  status: "ready" | "attention" | "blocked";
  checks: TargetReadinessCheck[];
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

export const deleteWorkspaceInput = z.object({
  workspaceId: z.string().min(1),
  revision: z.string().min(1),
});

export const choosePathInput = z.object({
  kind: z.enum(["directory", "file"]),
});

export const inspectDirectoryInput = z.object({
  path: z.string().min(1),
});

export const inspectAgentConfigurationInput = z.object({
  path: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
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

export const credentialStatusInput = z.object({
  workspaceId: z.string().min(1),
});

export const credentialImportInput = z.object({
  workspaceId: z.string().min(1),
  referenceId: z.string().min(1),
  targetId: z.string().min(1).optional(),
  /** Absolute path of a file to import. Chosen by the user, read in main. */
  sourcePath: z.string().min(1).optional(),
  /** Pasted secret. Never logged and never returned to the renderer. */
  secret: z.string().min(1).max(200_000).optional(),
});

export const credentialAuthenticateInput = z.object({
  workspaceId: z.string().min(1),
  referenceId: z.string().min(1),
});

export const credentialForgetInput = z.object({
  workspaceId: z.string().min(1),
  referenceId: z.string().min(1),
  targetId: z.string().min(1).optional(),
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
  deleteWorkspace(workspaceId: string, revision: string): Promise<void>;
  choosePath(kind: "directory" | "file"): Promise<string | null>;
  inspectDirectory(path: string): Promise<DirectoryInspection>;
  inspectAgentConfiguration(
    path: string,
    workspaceId?: string,
  ): Promise<AgentConfigurationInspection>;
  discoverLocalResources(): Promise<LocalResourceOptions>;
  /** Authentication status for every credential the workspace declares. */
  credentialStatus(workspaceId: string): Promise<CredentialStatus[]>;
  /**
   * Stores a secret for a declared reference. Either a file the user picked or
   * a pasted value; the secret itself never travels back to the renderer.
   */
  importCredential(input: {
    workspaceId: string;
    referenceId: string;
    targetId?: string;
    sourcePath?: string;
    secret?: string;
  }): Promise<CredentialStatus[]>;
  /**
   * Runs the provider's interactive sign-in in the main process. Used by
   * AWS profiles, whose credentials are never stored by OpsCapsule.
   */
  authenticateCredential(input: {
    workspaceId: string;
    referenceId: string;
  }): Promise<CredentialStatus[]>;
  /** Sign out. Removes the stored secret, keeping the reference. */
  forgetCredential(input: {
    workspaceId: string;
    referenceId: string;
    targetId?: string;
  }): Promise<CredentialStatus[]>;
  checkTargetReadiness(
    workspaceId: string,
    targetId: string,
  ): Promise<TargetReadinessReport>;
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

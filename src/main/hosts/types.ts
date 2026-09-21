import type { PlatformPath } from "node:path";
import type {
  DirectoryInspection,
  RuntimePaths,
  TargetReadinessReport,
} from "../../shared/contracts.js";
import type { PreparedIsolation } from "../isolation/types.js";
import type { CapsuleRuntime } from "../runtime-directory.js";
import type { TerminalWorkerRequest } from "../terminal-worker-protocol.js";
import type {
  PathResolutionContext,
  ResolvedWorkspaceTarget,
} from "../workspace-registry.js";

// The subset of Electron's UtilityProcess that the terminal manager relies
// on. The WSL host provides the same surface over a wsl.exe stdio pipe.
export interface TerminalWorkerProcess {
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  postMessage(message: TerminalWorkerRequest): void;
  kill(): boolean;
  on(event: "spawn", listener: () => void): this;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "exit", listener: (exitCode: number) => void): this;
  on(
    event: "error",
    listener: (type: string, location: string, report: string) => void,
  ): this;
}

export interface TerminalWorkerOptions {
  cwd: string;
  env: Record<string, string>;
}

export interface UtilityProcessForkOptions extends TerminalWorkerOptions {
  stdio: "pipe";
  serviceName: string;
}

export type UtilityProcessFork = (
  modulePath: string,
  args: string[],
  options: UtilityProcessForkOptions,
) => TerminalWorkerProcess;

// Where capsule processes execute and where their runtime files live. On
// macOS and Linux this is the Electron host itself; on Windows it is a WSL
// distribution.
export interface ExecutionHost {
  readonly id: "local" | "wsl";
  readonly label: string;
  readonly path: PlatformPath;
  readonly home: string;
  readonly stateDirectory: string;
  readonly paths: PathResolutionContext;
  // Converts a path chosen with the Electron host's file dialog into the
  // execution host's path form.
  translateHostPath(hostPath: string): Promise<string>;
  inspectDirectory(path: string): Promise<DirectoryInspection>;
  createDemoDirectories(directories: string[]): Promise<void>;
  cleanupStaleRuntimes(): Promise<void>;
  deleteWorkspaceState(workspaceId: string): Promise<void>;
  checkTargetReadiness(
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<TargetReadinessReport>;
  createRuntime(
    sessionId: string,
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<CapsuleRuntime>;
  cleanupRuntime(runtime: RuntimePaths): Promise<void>;
  prepareIsolation(
    runtime: RuntimePaths,
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<PreparedIsolation>;
  // Starts the application-owned terminal worker for one capsule.
  forkTerminalWorker(options: TerminalWorkerOptions): TerminalWorkerProcess;
}

export interface ExecutionHostOptions {
  userDataDirectory: string;
  applicationRoot: string;
  // Electron's utilityProcess.fork; injected so hosts stay testable without
  // the Electron runtime.
  forkUtilityProcess?: UtilityProcessFork;
}

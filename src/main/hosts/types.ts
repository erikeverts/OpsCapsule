import type { PlatformPath } from "node:path";
import type { DirectoryInspection, RuntimePaths } from "../../shared/contracts.js";
import type { PreparedIsolation } from "../isolation/types.js";
import type { ProcessLaunchSpec } from "../runtime-adapters/types.js";
import type { CapsuleRuntime } from "../runtime-directory.js";
import type {
  PathResolutionContext,
  ResolvedWorkspaceTarget,
} from "../workspace-registry.js";

export interface PtyLaunch {
  file: string;
  args: string[];
  cwd: string | undefined;
  env: Record<string, string>;
}

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
  createRuntime(
    sessionId: string,
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<CapsuleRuntime>;
  cleanupRuntime(runtime: RuntimePaths): Promise<void>;
  prepareIsolation(
    runtime: RuntimePaths,
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<PreparedIsolation>;
  launch(launchSpec: ProcessLaunchSpec): PtyLaunch;
}

export interface ExecutionHostOptions {
  userDataDirectory: string;
  applicationRoot: string;
}

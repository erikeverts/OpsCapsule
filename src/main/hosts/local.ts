import path from "node:path";
import type {
  DirectoryInspection,
  RuntimePaths,
  TargetReadinessReport,
} from "../../shared/contracts.js";
import { createDemoDirectories } from "../default-workspaces.js";
import { inspectDirectory } from "../local-resources.js";
import { prepareIsolation } from "../isolation/prepare.js";
import type { PreparedIsolation } from "../isolation/types.js";
import {
  cleanupStaleWorkspaceRuntimes,
  cleanupWorkspaceRuntime,
  createCapsuleRuntime,
  deleteWorkspaceState,
  type CapsuleRuntime,
} from "../runtime-directory.js";
import { checkTargetReadiness } from "../target-readiness.js";
import {
  localPathResolution,
  type ResolvedWorkspaceTarget,
} from "../workspace-registry.js";
import type {
  ExecutionHost,
  ExecutionHostOptions,
  TerminalWorkerOptions,
  TerminalWorkerProcess,
  UtilityProcessFork,
} from "./types.js";

const platformLabels: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
};

export const terminalWorkerServiceName = "OpsCapsule Terminal Worker";

export function terminalWorkerPath(
  applicationRoot: string,
  hostPath: Pick<path.PlatformPath, "join"> = path,
): string {
  return hostPath.join(applicationRoot, "dist", "terminal-worker.cjs");
}

export class LocalExecutionHost implements ExecutionHost {
  readonly id = "local";
  readonly label = platformLabels[process.platform] ?? process.platform;
  readonly path = path;
  readonly paths = localPathResolution;
  readonly home = localPathResolution.home;
  readonly stateDirectory: string;
  private readonly workerPath: string;
  private readonly forkUtilityProcess: UtilityProcessFork;

  constructor(options: ExecutionHostOptions) {
    this.stateDirectory = options.userDataDirectory;
    this.workerPath = terminalWorkerPath(options.applicationRoot);
    this.forkUtilityProcess =
      options.forkUtilityProcess ??
      (() => {
        throw new Error("Terminal workers require the Electron utility process API");
      });
  }

  translateHostPath(hostPath: string): Promise<string> {
    return Promise.resolve(hostPath);
  }

  inspectDirectory(path: string): Promise<DirectoryInspection> {
    return inspectDirectory(path);
  }

  createDemoDirectories(directories: string[]): Promise<void> {
    return createDemoDirectories(directories);
  }

  cleanupStaleRuntimes(): Promise<void> {
    return cleanupStaleWorkspaceRuntimes(this.stateDirectory);
  }

  deleteWorkspaceState(workspaceId: string): Promise<void> {
    return deleteWorkspaceState(this.stateDirectory, workspaceId);
  }

  checkTargetReadiness(
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<TargetReadinessReport> {
    return checkTargetReadiness(resolvedTarget);
  }

  createRuntime(
    sessionId: string,
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<CapsuleRuntime> {
    return createCapsuleRuntime(this.stateDirectory, sessionId, resolvedTarget);
  }

  cleanupRuntime(runtime: RuntimePaths): Promise<void> {
    return cleanupWorkspaceRuntime(runtime);
  }

  prepareIsolation(
    runtime: RuntimePaths,
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<PreparedIsolation> {
    return prepareIsolation(runtime, resolvedTarget);
  }

  forkTerminalWorker(options: TerminalWorkerOptions): TerminalWorkerProcess {
    return this.forkUtilityProcess(this.workerPath, [], {
      ...options,
      stdio: "pipe",
      serviceName: terminalWorkerServiceName,
    });
  }
}

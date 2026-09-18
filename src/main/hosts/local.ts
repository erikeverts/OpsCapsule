import path from "node:path";
import type { DirectoryInspection, RuntimePaths } from "../../shared/contracts.js";
import { createDemoDirectories } from "../default-workspaces.js";
import { inspectDirectory } from "../local-resources.js";
import { prepareIsolation } from "../isolation/prepare.js";
import type { PreparedIsolation } from "../isolation/types.js";
import type { ProcessLaunchSpec } from "../runtime-adapters/types.js";
import {
  cleanupStaleWorkspaceRuntimes,
  cleanupWorkspaceRuntime,
  createCapsuleRuntime,
  type CapsuleRuntime,
} from "../runtime-directory.js";
import {
  localPathResolution,
  type ResolvedWorkspaceTarget,
} from "../workspace-registry.js";
import type { ExecutionHost, ExecutionHostOptions, PtyLaunch } from "./types.js";

const platformLabels: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
};

export class LocalExecutionHost implements ExecutionHost {
  readonly id = "local";
  readonly label = platformLabels[process.platform] ?? process.platform;
  readonly path = path;
  readonly paths = localPathResolution;
  readonly home = localPathResolution.home;
  readonly stateDirectory: string;
  private readonly applicationRoot: string;

  constructor(options: ExecutionHostOptions) {
    this.stateDirectory = options.userDataDirectory;
    this.applicationRoot = options.applicationRoot;
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
    return prepareIsolation(this.applicationRoot, runtime, resolvedTarget);
  }

  launch(launchSpec: ProcessLaunchSpec): PtyLaunch {
    return {
      file: launchSpec.command,
      args: launchSpec.args,
      cwd: launchSpec.cwd,
      env: launchSpec.env,
    };
  }
}

import type { DirectoryInspection, RuntimePaths } from "../../shared/contracts.js";
import type { IsolationDescriptor } from "../isolation/launcher.js";
import type { CapsuleRuntime } from "../runtime-directory.js";
import type { ResolvedWorkspaceTarget } from "../workspace-registry.js";

// The helper runs inside the WSL distribution under Node.js. Its stdout may
// contain login-shell noise, so the single JSON result line is marked.
export const resultMarker = "OPSCAPSULE_RESULT ";

export interface WslProbeResult {
  home: string;
  stateDirectory: string;
  shell: string;
  nodeVersion: string;
  distribution: string;
}

export interface WslHelperRequests {
  probe: Record<string, never>;
  "seed-demo": { directories: string[] };
  "inspect-directory": { path: string };
  "cleanup-stale": { baseDirectory: string };
  "create-runtime": {
    baseDirectory: string;
    sessionId: string;
    resolvedTarget: ResolvedWorkspaceTarget;
  };
  "cleanup-runtime": { runtime: RuntimePaths };
  "prepare-isolation": {
    applicationRoot: string;
    runtime: RuntimePaths;
    resolvedTarget: ResolvedWorkspaceTarget;
  };
}

export interface WslHelperResponses {
  probe: WslProbeResult;
  "seed-demo": Record<string, never>;
  "inspect-directory": DirectoryInspection;
  "cleanup-stale": Record<string, never>;
  "create-runtime": CapsuleRuntime;
  "cleanup-runtime": Record<string, never>;
  "prepare-isolation": IsolationDescriptor;
}

export type WslHelperCommand = keyof WslHelperRequests;

export type WslHelperResult<Command extends WslHelperCommand> =
  | { ok: true; value: WslHelperResponses[Command] }
  | { ok: false; error: string };

export const wslHelperCommands: readonly WslHelperCommand[] = [
  "probe",
  "seed-demo",
  "inspect-directory",
  "cleanup-stale",
  "create-runtime",
  "cleanup-runtime",
  "prepare-isolation",
];

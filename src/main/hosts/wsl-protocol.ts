import type {
  DirectoryInspection,
  RuntimePaths,
  TargetReadinessReport,
} from "../../shared/contracts.js";
import type { PreparedIsolation } from "../isolation/types.js";
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
  "delete-workspace-state": { baseDirectory: string; workspaceId: string };
  "check-readiness": { resolvedTarget: ResolvedWorkspaceTarget };
  "create-runtime": {
    baseDirectory: string;
    sessionId: string;
    resolvedTarget: ResolvedWorkspaceTarget;
  };
  "cleanup-runtime": { runtime: RuntimePaths };
  "prepare-isolation": {
    runtime: RuntimePaths;
    resolvedTarget: ResolvedWorkspaceTarget;
  };
}

export interface WslHelperResponses {
  probe: WslProbeResult;
  "seed-demo": Record<string, never>;
  "inspect-directory": DirectoryInspection;
  "cleanup-stale": Record<string, never>;
  "delete-workspace-state": Record<string, never>;
  "check-readiness": TargetReadinessReport;
  "create-runtime": CapsuleRuntime;
  "cleanup-runtime": Record<string, never>;
  "prepare-isolation": PreparedIsolation;
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
  "delete-workspace-state",
  "check-readiness",
  "create-runtime",
  "cleanup-runtime",
  "prepare-isolation",
];

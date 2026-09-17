import type { EffectiveIsolation, RuntimePaths } from "../../shared/contracts.js";
import type { ProcessLaunchSpec } from "../runtime-adapters/types.js";

export interface PreparedIsolation {
  readonly effective: EffectiveIsolation;
  wrap(launchSpec: ProcessLaunchSpec): ProcessLaunchSpec;
}

export interface IsolationBackend {
  readonly id: string;
  prepare(): Promise<PreparedIsolation>;
}

export interface IsolationPreparationContext {
  applicationRoot: string;
  runtime: RuntimePaths;
  readOnlyPaths: string[];
  readWritePaths: string[];
  network: {
    mode: "public" | "deny" | "allowlist";
    allowedDomains: string[];
  };
}

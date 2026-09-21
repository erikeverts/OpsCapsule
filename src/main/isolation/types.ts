import type { EffectiveIsolation, RuntimePaths } from "../../shared/contracts.js";

export interface PreparedIsolation {
  readonly effective: EffectiveIsolation;
  readonly execution:
    | { backend: "none" }
    | {
        backend: "sandbox-runtime";
        settingsPath: string;
        networkMode: EffectiveIsolation["networkMode"];
      };
}

export interface IsolationBackend {
  readonly id: string;
  prepare(): Promise<PreparedIsolation>;
}

export interface IsolationPreparationContext {
  runtime: RuntimePaths;
  readOnlyPaths: string[];
  readWritePaths: string[];
  network: {
    mode: "public" | "deny" | "allowlist";
    allowedDomains: string[];
  };
}

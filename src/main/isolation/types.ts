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
  /**
   * Absolute path of the one unix socket this capsule session may reach: its
   * own credential broker. Undefined when no credentials are brokered, in
   * which case the capsule keeps no channel to the main process at all.
   */
  brokerSocket?: string;
}

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
  /** User-configured roots shown as part of the effective capsule boundary. */
  readOnlyPaths: string[];
  /**
   * Narrow application/runtime dependencies required to start the capsule,
   * such as a user-local agent executable. These enter the sandbox policy but
   * are not presented as workspace filesystem roots.
   */
  runtimeReadOnlyPaths?: string[];
  readWritePaths: string[];
  network: {
    mode: "public" | "deny" | "allowlist";
    allowedDomains: string[];
  };
  /** Exact unix socket paths for narrowly scoped application services. */
  allowedUnixSockets?: string[];
  /** @deprecated Use allowedUnixSockets. Kept for compatibility callers. */
  brokerSocket?: string;
}

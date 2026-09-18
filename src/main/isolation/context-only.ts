import type { EffectiveIsolation } from "../../shared/contracts.js";
import type { ProcessLaunchSpec } from "../runtime-adapters/types.js";
import type { PreparedIsolation } from "./types.js";

export class ContextOnlyIsolation implements PreparedIsolation {
  readonly effective: EffectiveIsolation;
  readonly launcher = null;

  constructor(
    readOnlyPaths: string[],
    readWritePaths: string[],
    networkMode: EffectiveIsolation["networkMode"],
  ) {
    this.effective = {
      mode: "context-only",
      backend: "none",
      readOnlyPaths,
      readWritePaths,
      networkMode,
    };
  }

  wrap(launchSpec: ProcessLaunchSpec): ProcessLaunchSpec {
    return launchSpec;
  }
}


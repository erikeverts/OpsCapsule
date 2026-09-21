import type { EffectiveIsolation } from "../../shared/contracts.js";
import type { PreparedIsolation } from "./types.js";

export class ContextOnlyIsolation implements PreparedIsolation {
  readonly effective: EffectiveIsolation;
  readonly execution = { backend: "none" } as const;

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
}

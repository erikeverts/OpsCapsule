import { realpath } from "node:fs/promises";
import type { RuntimePaths } from "../../shared/contracts.js";
import type { ResolvedWorkspaceTarget } from "../workspace-registry.js";
import { ContextOnlyIsolation } from "./context-only.js";
import { SandboxRuntimeIsolationBackend } from "./sandbox-runtime.js";
import type { PreparedIsolation } from "./types.js";

export async function prepareIsolation(
  runtime: RuntimePaths,
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<PreparedIsolation> {
  const directories = await Promise.all(
    resolvedTarget.directories.map(async (directory) => ({
      path: await realpath(directory.path),
      access: directory.access,
    })),
  );
  const readOnlyPaths = directories
    .filter(({ access }) => access === "read-only")
    .map(({ path }) => path);
  const readWritePaths = directories
    .filter(({ access }) => access === "read-write")
    .map(({ path }) => path);

  if (resolvedTarget.target.isolation.mode === "context-only") {
    return new ContextOnlyIsolation(
      readOnlyPaths,
      [
        ...readWritePaths,
        runtime.root,
        runtime.temp,
        runtime.targetState,
      ],
      resolvedTarget.target.isolation.network.mode,
    );
  }

  return new SandboxRuntimeIsolationBackend({
    runtime,
    readOnlyPaths,
    readWritePaths: [...readWritePaths, runtime.targetState],
    network: resolvedTarget.target.isolation.network,
  }).prepare();
}

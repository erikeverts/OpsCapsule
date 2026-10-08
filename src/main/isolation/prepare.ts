import type { RuntimePaths } from "../../shared/contracts.js";
import type { ResolvedWorkspaceTarget } from "../workspace-registry.js";
import { ContextOnlyIsolation } from "./context-only.js";
import { resolvePathChain } from "./path-chain.js";
import { SandboxRuntimeIsolationBackend } from "./sandbox-runtime.js";
import type { PreparedIsolation } from "./types.js";

export async function prepareIsolation(
  runtime: RuntimePaths,
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<PreparedIsolation> {
  // A directory reached through a symbolic link has several path forms, and
  // the agent uses the one that was configured. Allowing only the resolved
  // path leaves that directory unreachable by the name the user gave it.
  const directories = await Promise.all(
    resolvedTarget.directories.map(async (directory) => ({
      paths: await resolvePathChain(directory.path),
      access: directory.access,
    })),
  );
  const readOnlyPaths = directories
    .filter(({ access }) => access === "read-only")
    .flatMap(({ paths }) => paths);
  const readWritePaths = directories
    .filter(({ access }) => access === "read-write")
    .flatMap(({ paths }) => paths);

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
    brokerSocket: runtime.brokerSocket,
  }).prepare();
}

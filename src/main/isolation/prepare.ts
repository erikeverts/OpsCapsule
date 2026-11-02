import type { RuntimePaths } from "../../shared/contracts.js";
import type { ResolvedWorkspaceTarget } from "../workspace-registry.js";
import { ContextOnlyIsolation } from "./context-only.js";
import { resolvePathChain } from "./path-chain.js";
import { SandboxRuntimeIsolationBackend } from "./sandbox-runtime.js";
import type { PreparedIsolation } from "./types.js";
import { resolveExecutableWithSource } from "../runtime-adapters/readiness.js";

export async function prepareIsolation(
  runtime: RuntimePaths,
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<PreparedIsolation> {
  // A directory reached through a symbolic link has several path forms, and
  // the agent uses the one that was configured. Allowing only the resolved
  // path leaves that directory unreachable by the name the user gave it.
  const directories = await Promise.all(
    resolvedTarget.directories.map(async (directory) => {
      // An alias is a second name for the same directory, included by the
      // user. It needs the same treatment as the configured path: the links
      // it passes through have to be reachable too, or the name still fails.
      const chains = await Promise.all(
        [directory.path, ...directory.aliases].map((path) =>
          resolvePathChain(path),
        ),
      );
      return { paths: chains.flat(), access: directory.access };
    }),
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

  const configuredCommand = resolvedTarget.agent.profile.runtime.command;
  const command = configuredCommand === "$SHELL"
    ? process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh")
    : configuredCommand;
  const agentExecutable = await resolveExecutableWithSource(
    command,
    { PATH: process.env.PATH ?? "" },
    resolvedTarget.defaultDirectory.path,
  );
  // A user-local native agent is commonly a symlink such as
  // ~/.local/bin/claude -> ~/.local/share/claude/versions/<version>. The
  // capsule needs the launcher and payload, but never the rest of the home
  // directory. Resolving the chain keeps that grant as narrow as the command
  // selected by the profile.
  const agentExecutablePaths = await resolvePathChain(agentExecutable.source);
  const gitExecutablePaths = runtime.gitExecutable
    ? await resolvePathChain(runtime.gitExecutable)
    : [];

  return new SandboxRuntimeIsolationBackend({
    runtime,
    readOnlyPaths,
    runtimeReadOnlyPaths: [...agentExecutablePaths, ...gitExecutablePaths],
    readWritePaths: [...readWritePaths, runtime.targetState],
    network: resolvedTarget.target.isolation.network,
    brokerSocket: runtime.brokerSocket,
  }).prepare();
}

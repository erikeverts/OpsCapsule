import { readFile } from "node:fs/promises";
import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  type SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";
import type { ProcessLaunchSpec } from "../runtime-adapters/types.js";
import type { PreparedIsolation } from "./types.js";
import { allowsPublicDestination } from "./public-network.js";

type SandboxExecution = Extract<
  PreparedIsolation["execution"],
  { backend: "sandbox-runtime" }
>;

function quoteForPosixShell(argument: string): string {
  return `'${argument.split("'").join("'\\''")}'`;
}

export async function initializeSandboxRuntime(
  execution: SandboxExecution,
): Promise<void> {
  if (process.platform === "win32") {
    throw new Error(
      "Enforced isolation is not enabled on Windows in this iteration",
    );
  }

  const settings = SandboxRuntimeConfigSchema.parse(
    JSON.parse(await readFile(execution.settingsPath, "utf8")),
  );
  const allowPublicDestination: SandboxAskCallback | undefined =
    execution.networkMode === "public"
      ? async (destination) => allowsPublicDestination(destination)
      : undefined;

  await SandboxManager.initialize(settings, allowPublicDestination);
}

export async function wrapSandboxedLaunch(
  launchSpec: ProcessLaunchSpec,
  commandId: string,
): Promise<ProcessLaunchSpec> {
  const command = [launchSpec.command, ...launchSpec.args]
    .map(quoteForPosixShell)
    .join(" ");
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    command,
    undefined,
    undefined,
    undefined,
    launchSpec.cwd,
    { commandId, commandText: command },
  );
  const executable = wrapped.argv[0];
  if (!executable) {
    throw new Error("Sandbox Runtime did not return an executable");
  }
  return {
    command: executable,
    args: wrapped.argv.slice(1),
    cwd: launchSpec.cwd,
    // On the currently enforced macOS and Linux backends, Sandbox Runtime
    // bakes its proxy environment into the wrapped command and returns the
    // broker process environment unchanged. Keep the adapter's per-terminal
    // values (for example model-provider and agent-state variables) instead
    // of replacing them with the session worker's base environment.
    env: launchSpec.env,
  };
}

export function cleanupSandboxCommand(): void {
  SandboxManager.cleanupAfterCommand();
}

export async function resetSandboxRuntime(): Promise<void> {
  await SandboxManager.reset();
}

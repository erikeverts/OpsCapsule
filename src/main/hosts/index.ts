import { LocalExecutionHost } from "./local.js";
import type { ExecutionHost, ExecutionHostOptions } from "./types.js";
import { WslExecutionHost } from "./wsl.js";

export async function createExecutionHost(
  options: ExecutionHostOptions,
): Promise<ExecutionHost> {
  if (process.platform === "win32") {
    return WslExecutionHost.create({
      ...options,
      distribution: process.env.OPSCAPSULE_WSL_DISTRO || undefined,
    });
  }
  return new LocalExecutionHost(options);
}

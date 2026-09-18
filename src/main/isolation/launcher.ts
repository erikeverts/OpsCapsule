import type { EffectiveIsolation } from "../../shared/contracts.js";
import type { ProcessLaunchSpec } from "../runtime-adapters/types.js";
import type { IsolationLauncher, PreparedIsolation } from "./types.js";

// WSL interop lets a Linux process ask the WSL service to start a Windows
// executable outside any Linux sandbox. Enforced capsules never need it.
const interopEnvironmentVariables = ["WSL_INTEROP"];

export interface IsolationDescriptor {
  effective: EffectiveIsolation;
  launcher: IsolationLauncher | null;
}

export function wrapLaunchSpec(
  launcher: IsolationLauncher | null,
  launchSpec: ProcessLaunchSpec,
): ProcessLaunchSpec {
  if (!launcher) {
    return launchSpec;
  }
  const env = { ...launchSpec.env };
  for (const variable of interopEnvironmentVariables) {
    delete env[variable];
  }
  return {
    ...launchSpec,
    command: launcher.command,
    args: [...launcher.args, launchSpec.command, ...launchSpec.args],
    env,
  };
}

export function describePreparedIsolation(
  isolation: PreparedIsolation,
): IsolationDescriptor {
  return { effective: isolation.effective, launcher: isolation.launcher };
}

export function restorePreparedIsolation(
  descriptor: IsolationDescriptor,
): PreparedIsolation {
  return {
    effective: descriptor.effective,
    launcher: descriptor.launcher,
    wrap: (launchSpec) => wrapLaunchSpec(descriptor.launcher, launchSpec),
  };
}

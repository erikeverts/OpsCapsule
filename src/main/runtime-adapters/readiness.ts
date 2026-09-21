import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ProcessLaunchSpec } from "./types.js";

function executableCandidates(command: string): string[] {
  if (process.platform !== "win32") {
    return [command];
  }
  if (/\.[A-Za-z0-9]+$/.test(command)) {
    return [command];
  }
  return (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((extension) => `${command}${extension.toLowerCase()}`);
}

async function executable(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.X_OK);
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export async function resolveExecutable(
  command: string,
  environment: Record<string, string>,
  cwd: string,
): Promise<string> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (isAbsolute(command) || hasPathSeparator) {
    const base = isAbsolute(command) ? command : resolve(cwd, command);
    for (const candidate of executableCandidates(base)) {
      const resolved = await executable(candidate);
      if (resolved) {
        return resolved;
      }
    }
  } else {
    for (const directory of (environment.PATH ?? "").split(delimiter)) {
      if (!directory) {
        continue;
      }
      for (const candidate of executableCandidates(join(directory, command))) {
        const resolved = await executable(candidate);
        if (resolved) {
          return resolved;
        }
      }
    }
  }
  throw new Error(
    `Agent command '${command}' was not found or is not executable in the capsule PATH`,
  );
}

export async function prepareAgentLaunch(
  launchSpec: ProcessLaunchSpec,
): Promise<ProcessLaunchSpec> {
  const command = await resolveExecutable(
    launchSpec.command,
    launchSpec.env,
    launchSpec.cwd,
  );
  return { ...launchSpec, command };
}

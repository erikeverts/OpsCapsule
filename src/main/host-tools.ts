import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

interface HostPathOptions {
  inheritedPath?: string;
  loginShellPath?: string;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}

interface InitializeHostToolsOptions extends HostPathOptions {
  environment?: NodeJS.ProcessEnv;
  loadLoginShellPath?: (environment: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function expandHome(path: string, homeDirectory: string): string {
  if (path === "~") {
    return homeDirectory;
  }
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homeDirectory, path.slice(2));
  }
  return path;
}

function fallbackDirectories(
  platform: NodeJS.Platform,
  homeDirectory: string,
): string[] {
  if (platform === "win32") {
    // Claude Code's native Windows installer uses the same user-local launcher
    // shape as macOS and Linux. The inherited Windows PATH supplies the normal
    // Program Files and system locations.
    return [join(homeDirectory, ".local", "bin")];
  }

  const common = [
    join(homeDirectory, ".local", "bin"),
    join(homeDirectory, "bin"),
  ];
  if (platform === "darwin") {
    common.push(
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
    );
  } else {
    common.push("/usr/local/bin", "/usr/local/sbin");
  }
  common.push("/usr/bin", "/bin", "/usr/sbin", "/sbin");
  return common;
}

/**
 * Builds the executable search path used by every host-side tool lookup.
 *
 * Finder- and Dock-launched macOS applications normally receive only the
 * system path, while a terminal receives the user's shell path. The explicit
 * fallbacks keep normal Homebrew and user-local installations available even
 * when shell discovery fails. Relative entries are intentionally discarded:
 * resolving an executable relative to an operations workspace is both
 * surprising and unsafe.
 */
export function buildHostExecutablePath(options: HostPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const delimiter = pathDelimiter(platform);
  const candidates = [
    ...(options.loginShellPath ?? "").split(delimiter),
    ...(options.inheritedPath ?? "").split(delimiter),
    ...fallbackDirectories(platform, homeDirectory),
  ];
  const directories = new Set<string>();
  for (const candidate of candidates) {
    const expanded = expandHome(candidate.trim(), homeDirectory);
    if (!expanded || !isAbsolute(expanded)) {
      continue;
    }
    directories.add(expanded);
  }
  return [...directories].join(delimiter);
}

export function pathFromNullDelimitedEnvironment(output: Buffer): string | undefined {
  for (const entry of output.toString("utf8").split("\0")) {
    const start = entry.lastIndexOf("PATH=");
    if (start === 0 || (start > 0 && entry[start - 1] === "\n")) {
      const path = entry.slice(start + "PATH=".length).trim();
      if (path) {
        return path;
      }
    }
  }
  return undefined;
}

/**
 * Reads only PATH from the user's interactive login shell. No other shell
 * variables enter a capsule. Shell startup is bounded and optional so a slow
 * or broken profile cannot prevent OpsCapsule from opening.
 */
export async function loginShellPath(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }
  const shell = environment.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  if (!isAbsolute(shell)) {
    return undefined;
  }
  try {
    const { stdout } = await run(shell, ["-ilc", "/usr/bin/env -0"], {
      cwd: environment.HOME || homedir(),
      encoding: "buffer",
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5_000,
    });
    return pathFromNullDelimitedEnvironment(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Normalises process.env.PATH once during application startup. All existing
 * readiness, credential, isolation, and terminal code then observes the same
 * launch-independent path without importing the rest of the login shell.
 */
export async function initializeHostToolEnvironment(
  options: InitializeHostToolsOptions = {},
): Promise<string> {
  const environment = options.environment ?? process.env;
  const load = options.loadLoginShellPath ?? loginShellPath;
  const discovered = await load(environment);
  const path = buildHostExecutablePath({
    inheritedPath: options.inheritedPath ?? environment.PATH,
    loginShellPath: options.loginShellPath ?? discovered,
    homeDirectory: options.homeDirectory,
    platform: options.platform,
  });
  environment.PATH = path;
  return path;
}

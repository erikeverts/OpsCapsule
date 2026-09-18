import { spawn } from "node:child_process";
import { posix, win32 } from "node:path";
import type { DirectoryInspection, RuntimePaths } from "../../shared/contracts.js";
import { restorePreparedIsolation } from "../isolation/launcher.js";
import type { PreparedIsolation } from "../isolation/types.js";
import type { ProcessLaunchSpec } from "../runtime-adapters/types.js";
import type { CapsuleRuntime } from "../runtime-directory.js";
import type {
  PathResolutionContext,
  ResolvedWorkspaceTarget,
} from "../workspace-registry.js";
import type { ExecutionHost, ExecutionHostOptions, PtyLaunch } from "./types.js";
import {
  resultMarker,
  type WslHelperCommand,
  type WslHelperRequests,
  type WslHelperResponses,
  type WslHelperResult,
  type WslProbeResult,
} from "./wsl-protocol.js";

export interface WslProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type WslCommandRunner = (
  args: string[],
  input?: string,
) => Promise<WslProcessResult>;

export interface WslExecutionHostOptions extends ExecutionHostOptions {
  distribution?: string;
  run?: WslCommandRunner;
  hostEnvironment?: NodeJS.ProcessEnv;
}

export const wslExecutable = "wsl.exe";

// Runs the helper through the user's login shell so Node.js installed via
// profile-managed PATH entries is found. Common Debian and Ubuntu rc files
// only configure version managers such as nvm for interactive shells, so an
// interactive login shell is the fallback. Positional arguments are never
// interpolated into the script.
export function loginShellBootstrap(interactive: boolean): string {
  const flags = interactive ? "-l -i" : "-l";
  return [
    'case "${SHELL:-/bin/sh}" in',
    `  */bash|*/zsh|*/sh|*/dash|*/ksh) exec "$SHELL" ${flags} -c 'exec "$@"' opscapsule "$@" ;;`,
    `  *) exec /bin/sh ${flags} -c 'exec "$@"' opscapsule "$@" ;;`,
    "esac",
  ].join("\n");
}

const translatePathsScript = 'for p in "$@"; do wslpath -a -u "$p" || exit 1; done';

// wsl.exe prints its own diagnostics as UTF-16LE while Linux output is UTF-8.
export function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length >= 2) {
    let zeroOddBytes = 0;
    for (let index = 1; index < buffer.length; index += 2) {
      if (buffer[index] === 0) {
        zeroOddBytes += 1;
      }
    }
    if (zeroOddBytes > buffer.length / 4) {
      return buffer.toString("utf16le");
    }
  }
  return buffer.toString("utf8");
}

// Shell rc files may write to stdout without a trailing newline, so the
// marker is located anywhere in the output rather than at a line start.
export function parseHelperOutput<Command extends WslHelperCommand>(
  stdout: string,
): WslHelperResult<Command> | undefined {
  const start = stdout.lastIndexOf(resultMarker);
  if (start < 0) {
    return undefined;
  }
  const payload = stdout.slice(start + resultMarker.length);
  const end = payload.search(/\r?\n/);
  return JSON.parse(
    end < 0 ? payload : payload.slice(0, end),
  ) as WslHelperResult<Command>;
}

export function isMissingNodeFailure(result: WslProcessResult): boolean {
  return (
    result.exitCode === 127 ||
    /node: (command )?not found|command not found: node/i.test(result.stderr)
  );
}

export function toEnvironmentArguments(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([name]) => /^[^=\s]+$/.test(name))
    .map(([name, value]) => `${name}=${value}`);
}

function defaultRunner(args: string[], input?: string): Promise<WslProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(wslExecutable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolvePromise({
        stdout: decodeWslOutput(Buffer.concat(stdout)),
        stderr: decodeWslOutput(Buffer.concat(stderr)),
        exitCode,
      }),
    );
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export class WslExecutionHost implements ExecutionHost {
  readonly id = "wsl";
  readonly label: string;
  readonly path = posix;
  readonly home: string;
  readonly stateDirectory: string;
  readonly paths: PathResolutionContext;
  private readonly distributionArguments: string[];
  private readonly userDataDirectory: string;
  private readonly userDataLinuxPath: string;
  private readonly applicationRootLinuxPath: string;
  private readonly client: WslHelperClient;
  private readonly run: WslCommandRunner;
  private readonly hostEnvironment: Record<string, string>;

  private constructor(
    options: WslExecutionHostOptions,
    translated: { userData: string; applicationRoot: string },
    client: WslHelperClient,
    probe: WslProbeResult,
  ) {
    this.distributionArguments = distributionArguments(options.distribution);
    this.client = client;
    this.run = options.run ?? defaultRunner;
    this.hostEnvironment = stringEnvironment(
      options.hostEnvironment ?? process.env,
    );
    this.userDataDirectory = win32.normalize(options.userDataDirectory);
    this.userDataLinuxPath = translated.userData;
    this.applicationRootLinuxPath = translated.applicationRoot;
    this.home = probe.home;
    this.stateDirectory = probe.stateDirectory;
    this.label = probe.distribution ? `WSL (${probe.distribution})` : "WSL";
    this.paths = {
      home: probe.home,
      path: posix,
      manifestDirectory: (sourcePath) =>
        this.translateUserDataPath(win32.dirname(sourcePath)),
    };
  }

  static async create(options: WslExecutionHostOptions): Promise<WslExecutionHost> {
    const run = options.run ?? defaultRunner;
    const distribution = distributionArguments(options.distribution);
    const translated = await translatePaths(run, distribution, [
      options.userDataDirectory,
      options.applicationRoot,
    ]);
    const [userData, applicationRoot] = translated;
    if (!userData || !applicationRoot) {
      throw new Error("WSL did not translate the application paths");
    }
    const client = new WslHelperClient(
      run,
      distribution,
      posix.join(applicationRoot, "dist", "wsl-helper.cjs"),
    );
    const probe = await client.call("probe", {});
    return new WslExecutionHost(
      options,
      { userData, applicationRoot },
      client,
      probe,
    );
  }

  translateUserDataPath(windowsPath: string): string {
    const relative = win32.relative(
      this.userDataDirectory,
      win32.normalize(windowsPath),
    );
    if (relative.startsWith("..") || win32.isAbsolute(relative)) {
      throw new Error(
        `Path '${windowsPath}' is outside the application data directory and cannot be resolved inside WSL`,
      );
    }
    return posix.join(
      this.userDataLinuxPath,
      ...relative.split(win32.sep).filter(Boolean),
    );
  }

  async translateHostPath(hostPath: string): Promise<string> {
    const [translated] = await translatePaths(
      this.run,
      this.distributionArguments,
      [hostPath],
    );
    if (!translated) {
      throw new Error(`WSL could not translate '${hostPath}'`);
    }
    return translated;
  }

  inspectDirectory(path: string): Promise<DirectoryInspection> {
    return this.helper("inspect-directory", { path });
  }

  async createDemoDirectories(directories: string[]): Promise<void> {
    await this.helper("seed-demo", { directories });
  }

  async cleanupStaleRuntimes(): Promise<void> {
    await this.helper("cleanup-stale", { baseDirectory: this.stateDirectory });
  }

  createRuntime(
    sessionId: string,
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<CapsuleRuntime> {
    return this.helper("create-runtime", {
      baseDirectory: this.stateDirectory,
      sessionId,
      resolvedTarget: this.forDistribution(resolvedTarget),
    });
  }

  async cleanupRuntime(runtime: RuntimePaths): Promise<void> {
    await this.helper("cleanup-runtime", { runtime });
  }

  async prepareIsolation(
    runtime: RuntimePaths,
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<PreparedIsolation> {
    return restorePreparedIsolation(
      await this.helper("prepare-isolation", {
        applicationRoot: this.applicationRootLinuxPath,
        runtime,
        resolvedTarget: this.forDistribution(resolvedTarget),
      }),
    );
  }

  // Runtime code resolves manifest-relative resource paths against the
  // manifest location, so the helper must see it as mounted inside WSL.
  private forDistribution(
    resolvedTarget: ResolvedWorkspaceTarget,
  ): ResolvedWorkspaceTarget {
    return {
      ...resolvedTarget,
      workspace: {
        ...resolvedTarget.workspace,
        sourcePath: this.translateUserDataPath(
          resolvedTarget.workspace.sourcePath,
        ),
      },
    };
  }

  // The capsule environment is passed explicitly with `env -i`, so nothing
  // from the Windows process or the WSL login session leaks in implicitly.
  launch(launchSpec: ProcessLaunchSpec): PtyLaunch {
    const env = { TERM: "xterm-256color", ...launchSpec.env };
    return {
      file: wslExecutable,
      args: [
        ...this.distributionArguments,
        "--cd",
        launchSpec.cwd,
        "--exec",
        "/usr/bin/env",
        "-i",
        ...toEnvironmentArguments(env),
        launchSpec.command,
        ...launchSpec.args,
      ],
      cwd: undefined,
      env: this.hostEnvironment,
    };
  }

  private helper<Command extends WslHelperCommand>(
    command: Command,
    request: WslHelperRequests[Command],
  ): Promise<WslHelperResponses[Command]> {
    return this.client.call(command, request);
  }
}

function distributionArguments(distribution: string | undefined): string[] {
  return distribution ? ["--distribution", distribution] : [];
}

function describeFailure(result: WslProcessResult): string {
  const detail = (result.stderr || result.stdout).trim();
  return detail
    ? `${detail} (exit code ${result.exitCode ?? "unknown"})`
    : `exit code ${result.exitCode ?? "unknown"}`;
}

async function translatePaths(
  run: WslCommandRunner,
  distribution: string[],
  windowsPaths: string[],
): Promise<string[]> {
  let result: WslProcessResult;
  try {
    result = await run([
      ...distribution,
      "--exec",
      "/bin/sh",
      "-c",
      translatePathsScript,
      "opscapsule",
      ...windowsPaths,
    ]);
  } catch (error) {
    throw new Error(
      `OpsCapsule on Windows requires WSL 2 with a Linux distribution: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `WSL is not ready. Install or start a WSL 2 distribution and try again: ${describeFailure(result)}`,
    );
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== windowsPaths.length) {
    throw new Error(`WSL returned unexpected path output: ${result.stdout.trim()}`);
  }
  return lines;
}

export class WslHelperClient {
  private interactive: boolean | undefined;

  constructor(
    private readonly run: WslCommandRunner,
    private readonly distribution: string[],
    private readonly helperPath: string,
  ) {}

  async call<Command extends WslHelperCommand>(
    command: Command,
    request: WslHelperRequests[Command],
  ): Promise<WslHelperResponses[Command]> {
    const modes = this.interactive === undefined ? [false, true] : [this.interactive];
    let lastResult: WslProcessResult | undefined;
    for (const interactive of modes) {
      const result = await this.invoke(interactive, command, request);
      const parsed = parseHelperOutput<Command>(result.stdout);
      if (parsed) {
        this.interactive = interactive;
        if (!parsed.ok) {
          throw new Error(parsed.error);
        }
        return parsed.value;
      }
      lastResult = result;
      if (!isMissingNodeFailure(result)) {
        break;
      }
    }
    if (lastResult && isMissingNodeFailure(lastResult)) {
      throw new Error(
        "Node.js was not found on the login-shell PATH inside WSL. Install Node.js in the distribution and try again.",
      );
    }
    throw new Error(
      `WSL helper '${command}' failed: ${lastResult ? describeFailure(lastResult) : "no result"}`,
    );
  }

  private invoke(
    interactive: boolean,
    command: WslHelperCommand,
    request: unknown,
  ): Promise<WslProcessResult> {
    return this.run(
      [
        ...this.distribution,
        "--exec",
        "/bin/sh",
        "-c",
        loginShellBootstrap(interactive),
        "opscapsule",
        "node",
        this.helperPath,
        command,
      ],
      JSON.stringify(request),
    );
  }
}

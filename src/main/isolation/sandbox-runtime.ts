import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { EffectiveIsolation } from "../../shared/contracts.js";
import type { ProcessLaunchSpec } from "../runtime-adapters/types.js";
import type {
  IsolationBackend,
  IsolationPreparationContext,
  PreparedIsolation,
} from "./types.js";

export interface SandboxRuntimeSettings {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    strictAllowlist: boolean;
    allowUnixSockets: string[];
    allowAllUnixSockets: boolean;
    allowLocalBinding: boolean;
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  enableWeakerNestedSandbox: boolean;
  enableWeakerNetworkIsolation: boolean;
  allowAppleEvents: boolean;
  allowPty: boolean;
}

const executeFile = promisify(execFile);

export function buildSandboxRuntimeSettings(options: {
  deniedReadPaths: string[];
  readOnlyPaths: string[];
  readWritePaths: string[];
  network: IsolationPreparationContext["network"];
  userHome: string;
}): SandboxRuntimeSettings {
  // Sandbox Runtime deliberately rejects "*" in an allowlist. Public mode
  // uses an empty list here and an explicit approval callback in our runner;
  // the runtime's resolved-address guard still blocks local/metadata targets.
  const allowedDomains =
    options.network.mode === "allowlist"
      ? options.network.allowedDomains
      : [];

  return {
    network: {
      allowedDomains,
      deniedDomains: options.network.mode === "deny" ? ["*"] : [],
      strictAllowlist: options.network.mode !== "public",
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: options.deniedReadPaths,
      allowRead: [...options.readOnlyPaths, ...options.readWritePaths],
      allowWrite: options.readWritePaths,
      denyWrite: [
        "/tmp/claude",
        "/private/tmp/claude",
        join(options.userHome, ".npm", "_logs"),
        join(options.userHome, ".claude", "debug"),
      ],
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    // Every OpsCapsule process is attached to a node-pty terminal. On macOS,
    // zsh needs Sandbox Runtime's pseudo-tty allowance for job control.
    allowPty: true,
  };
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function findOnPath(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(
    process.platform === "win32" ? ";" : ":",
  )) {
    if (!directory) {
      continue;
    }
    const candidate = join(directory, executableName(name));
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue looking through PATH.
    }
  }
  return undefined;
}

async function existingCanonicalPaths(paths: string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const path of paths) {
    try {
      canonical.push(await realpath(path));
    } catch {
      // A deny path that does not exist cannot expose data on this host.
    }
  }
  return [...new Set(canonical)];
}

async function deniedUserDataRoots(): Promise<string[]> {
  if (process.platform === "darwin") {
    return existingCanonicalPaths([
      dirname(homedir()),
      tmpdir(),
      "/tmp",
      "/private/tmp",
      "/Volumes",
    ]);
  }
  if (process.platform === "linux") {
    return existingCanonicalPaths([
      "/home",
      "/root",
      "/tmp",
      "/var/tmp",
      "/media",
      "/mnt",
    ]);
  }
  return [];
}

async function assertPlatformDependencies(): Promise<void> {
  if (process.platform === "darwin") {
    await access("/usr/bin/sandbox-exec", constants.X_OK);
    if (!(await findOnPath("rg"))) {
      throw new Error(
        "Enforced isolation requires ripgrep (rg) on macOS. Install it and try again.",
      );
    }
    try {
      await executeFile("/usr/bin/sandbox-exec", [
        "-p",
        "(version 1)\n(allow default)",
        "/usr/bin/true",
      ]);
    } catch {
      throw new Error(
        "macOS sandbox enforcement is unavailable in the current host environment",
      );
    }
    return;
  }
  if (process.platform === "linux") {
    const missing: string[] = [];
    for (const dependency of ["bwrap", "socat", "rg"]) {
      if (!(await findOnPath(dependency))) {
        missing.push(dependency);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Enforced isolation is missing Linux dependencies: ${missing.join(", ")}`,
      );
    }
    return;
  }
  throw new Error(
    "Enforced isolation is not enabled on Windows in this iteration; use context-only mode explicitly",
  );
}

class PreparedSandboxRuntimeIsolation implements PreparedIsolation {
  readonly effective: EffectiveIsolation;

  constructor(
    private readonly nodeExecutable: string,
    private readonly runnerPath: string,
    private readonly configPath: string,
    readOnlyPaths: string[],
    readWritePaths: string[],
    networkMode: EffectiveIsolation["networkMode"],
  ) {
    this.effective = {
      mode: "enforced",
      backend: "sandbox-runtime",
      readOnlyPaths,
      readWritePaths,
      networkMode,
    };
  }

  wrap(launchSpec: ProcessLaunchSpec): ProcessLaunchSpec {
    return {
      ...launchSpec,
      command: this.nodeExecutable,
      args: [
        this.runnerPath,
        "--settings",
        this.configPath,
        "--network-mode",
        this.effective.networkMode,
        "--",
        launchSpec.command,
        ...launchSpec.args,
      ],
    };
  }
}

export class SandboxRuntimeIsolationBackend implements IsolationBackend {
  readonly id = "sandbox-runtime";

  constructor(private readonly context: IsolationPreparationContext) {}

  async prepare(): Promise<PreparedIsolation> {
    await assertPlatformDependencies();
    const nodeExecutable = await findOnPath("node");
    if (!nodeExecutable) {
      throw new Error(
        "Enforced isolation currently requires a Node.js executable on PATH",
      );
    }
    const runnerPath = resolve(
      this.context.applicationRoot,
      "dist",
      "sandbox-runner.mjs",
    );
    await access(runnerPath, constants.R_OK);

    const readOnlyPaths = [...new Set(this.context.readOnlyPaths)];
    const readWritePaths = [
      ...new Set([
        ...this.context.readWritePaths,
        this.context.runtime.root,
        this.context.runtime.temp,
      ]),
    ];
    const settings = buildSandboxRuntimeSettings({
      deniedReadPaths: await deniedUserDataRoots(),
      readOnlyPaths,
      readWritePaths,
      network: this.context.network,
      userHome: homedir(),
    });

    await writeFile(
      this.context.runtime.sandboxConfig,
      `${JSON.stringify(settings, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    return new PreparedSandboxRuntimeIsolation(
      nodeExecutable,
      runnerPath,
      this.context.runtime.sandboxConfig,
      readOnlyPaths,
      readWritePaths,
      this.context.network.mode,
    );
  }
}

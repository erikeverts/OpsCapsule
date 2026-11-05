import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimePaths } from "../../shared/contracts.js";
import { resolveExecutable } from "../runtime-adapters/readiness.js";
import type { ResolvedWorkspaceTarget } from "../workspace-registry.js";

const PROFILE = "runtime";
const ALIAS_TOKEN = "state-alias";
const START_TIMEOUT_MS = 10 * 60 * 1000;

export interface ContainerCommandResult {
  stdout: string;
  stderr: string;
}

export type ContainerCommandRunner = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<ContainerCommandResult>;

const runCommand: ContainerCommandRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        env: options.env,
        timeout: options.timeout,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const output = [stderr, stdout].filter(Boolean).join("\n").trim();
          reject(
            new Error(
              `${executable} ${args.join(" ")} failed${output ? `: ${output}` : ""}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

function managedStateId(resolvedTarget: ResolvedWorkspaceTarget): string {
  return createHash("sha256")
    .update(resolvedTarget.workspace.manifest.metadata.id)
    .update("\0")
    .update(resolvedTarget.target.id)
    .digest("hex")
    .slice(0, 24);
}

export async function hasTargetColimaPersistentData(
  baseDirectory: string,
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<boolean> {
  const profileDirectory = join(
    baseDirectory,
    "state",
    "container-runtimes",
    managedStateId(resolvedTarget),
    PROFILE,
  );
  try {
    await lstat(profileDirectory);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function aliasToken(stateDirectory: string): Promise<string> {
  const path = join(stateDirectory, ALIAS_TOKEN);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Refusing unsafe container runtime identity file: ${path}`);
    }
    const token = (await readFile(path, "utf8")).trim();
    if (!/^[a-f0-9]{20}$/.test(token)) {
      throw new Error(`Container runtime identity file is invalid: ${path}`);
    }
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const token = randomBytes(10).toString("hex");
    await writeFile(path, `${token}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return token;
  }
}

async function ensureShortStateAlias(stateDirectory: string): Promise<string> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const aliasRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const alias = join(aliasRoot, `opscapsule-cr-${await aliasToken(stateDirectory)}`);
  try {
    const info = await lstat(alias);
    if (!info.isSymbolicLink()) {
      throw new Error(`Refusing occupied container runtime alias: ${alias}`);
    }
    if ((await realpath(alias)) !== (await realpath(stateDirectory))) {
      throw new Error(`Container runtime alias points at an unexpected location: ${alias}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await symlink(stateDirectory, alias, "dir");
  }
  return alias;
}

export async function createColimaRuntimePaths(
  baseDirectory: string,
  targetState: string,
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<NonNullable<RuntimePaths["containerRuntime"]>> {
  const stateDirectory = join(
    baseDirectory,
    "state",
    "container-runtimes",
    managedStateId(resolvedTarget),
  );
  const colimaHome = await ensureShortStateAlias(stateDirectory);
  const dockerConfig = join(targetState, "container-runtime", "docker-config");
  await mkdir(dockerConfig, { recursive: true, mode: 0o700 });
  return {
    provider: "colima",
    profile: PROFILE,
    stateDirectory,
    colimaHome,
    socket: join(colimaHome, PROFILE, "docker.sock"),
    dockerConfig,
  };
}

export async function createTargetColimaRuntimePaths(
  baseDirectory: string,
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<NonNullable<RuntimePaths["containerRuntime"]>> {
  const targetState = join(
    baseDirectory,
    "state",
    "workspaces",
    resolvedTarget.workspace.manifest.metadata.id,
    "targets",
    resolvedTarget.target.id,
  );
  return createColimaRuntimePaths(baseDirectory, targetState, resolvedTarget);
}

export type ExecutableResolver = (
  command: string,
  environment: Record<string, string>,
  cwd: string,
) => Promise<string>;

export interface ColimaPrerequisites {
  colima: string;
  docker: string;
}

function assertSupportedMounts(resolvedTarget: ResolvedWorkspaceTarget): void {
  const paths = resolvedTarget.directories.map(({ path }) => path);
  for (const path of paths) {
    if (!isAbsolute(path)) {
      throw new Error(`Container mount is not absolute: ${path}`);
    }
    if (path.includes(" ")) {
      throw new Error(
        `Colima cannot mount paths containing spaces: ${path}`,
      );
    }
    if (path.includes(":") || path.includes(",")) {
      throw new Error(
        `Colima cannot mount paths containing a colon or comma: ${path}`,
      );
    }
  }
  for (const [index, parent] of paths.entries()) {
    for (const child of paths.slice(index + 1)) {
      const childFromParent = relative(parent, child);
      const parentFromChild = relative(child, parent);
      const overlaps =
        childFromParent === "" ||
        (!childFromParent.startsWith("..") && !isAbsolute(childFromParent)) ||
        (!parentFromChild.startsWith("..") && !isAbsolute(parentFromChild));
      if (overlaps) {
        throw new Error(
          `Colima does not support overlapping target mounts: ${parent} and ${child}`,
        );
      }
    }
  }
}

export async function checkColimaPrerequisites(
  resolvedTarget: ResolvedWorkspaceTarget,
  resolve: ExecutableResolver = resolveExecutable,
  platform: NodeJS.Platform = process.platform,
): Promise<ColimaPrerequisites> {
  if (platform !== "darwin") {
    throw new Error(
      "The isolated Colima container runtime is currently available on macOS only.",
    );
  }
  assertSupportedMounts(resolvedTarget);
  const environment = { PATH: process.env.PATH ?? "" };
  const cwd = resolvedTarget.defaultDirectory.path;
  const [colima, docker] = await Promise.all([
    resolve("colima", environment, cwd).catch(() => {
      throw new Error(
        "Colima is required for isolated containers. Install it with 'brew install colima'.",
      );
    }),
    resolve("docker", environment, cwd).catch(() => {
      throw new Error(
        "The Docker CLI is required for isolated containers. Install it with 'brew install docker'.",
      );
    }),
  ]);
  return { colima, docker };
}

function colimaEnvironment(
  paths: NonNullable<RuntimePaths["containerRuntime"]>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COLIMA_HOME: paths.colimaHome,
    COLIMA_PROFILE: paths.profile,
    COLIMA_CACHE_HOME: join(paths.stateDirectory, "cache"),
    LIMA_HOME: join(paths.colimaHome, "_lima"),
    DOCKER_CONFIG: paths.dockerConfig,
  };
}

export function buildColimaStartArguments(
  resolvedTarget: ResolvedWorkspaceTarget,
): string[] {
  const configuration = resolvedTarget.target.containerRuntime;
  if (!configuration) {
    throw new Error("This target does not declare a container runtime");
  }
  const args = [
    "start",
    PROFILE,
    "--runtime=docker",
    "--kubernetes=false",
    "--activate=false",
    "--template=false",
    "--ssh-agent=false",
    "--ssh-config=false",
    "--port-forwarder=none",
    "--network-address=false",
    "--network-host-addresses=false",
    `--cpus=${configuration.resources.cpus}`,
    `--memory=${configuration.resources.memoryGiB}`,
    `--disk=${configuration.resources.diskGiB}`,
  ];
  for (const directory of resolvedTarget.directories) {
    args.push(
      "--mount",
      `${directory.path}${directory.access === "read-write" ? ":w" : ""}`,
    );
  }
  return args;
}

export class ColimaContainerRuntime {
  constructor(
    private readonly execute: ContainerCommandRunner = runCommand,
    private readonly resolve: ExecutableResolver = resolveExecutable,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async start(
    runtime: RuntimePaths,
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<void> {
    if (!runtime.containerRuntime) {
      return;
    }
    const tools = await checkColimaPrerequisites(
      resolvedTarget,
      this.resolve,
      this.platform,
    );
    const environment = colimaEnvironment(runtime.containerRuntime);
    try {
      await access(runtime.containerRuntime.socket);
      // A previous application crash can leave the VM alive. Restart it so
      // changed directory grants or resource limits cannot be ignored by
      // Colima's "already running" fast path.
      await this.execute(
        tools.colima,
        ["stop", runtime.containerRuntime.profile, "--force"],
        { env: environment, timeout: 2 * 60 * 1000 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await this.execute(tools.colima, buildColimaStartArguments(resolvedTarget), {
      env: environment,
      timeout: START_TIMEOUT_MS,
    });
    await access(runtime.containerRuntime.socket);
    await this.execute(
      tools.docker,
      [
        "--host",
        `unix://${runtime.containerRuntime.socket}`,
        "version",
        "--format",
        "{{.Server.Version}}",
      ],
      { env: environment, timeout: 30_000 },
    );
  }

  async stop(runtime: RuntimePaths): Promise<void> {
    const paths = runtime.containerRuntime;
    if (!paths) {
      return;
    }
    try {
      const colima = await this.resolve(
        "colima",
        { PATH: process.env.PATH ?? "" },
        dirname(paths.stateDirectory),
      );
      await this.execute(colima, ["stop", paths.profile, "--force"], {
        env: colimaEnvironment(paths),
        timeout: 2 * 60 * 1000,
      });
    } catch {
      // Stopping a capsule must still revoke credentials and remove its
      // session even if the optional VM was already stopped or disappeared.
    }
  }

  async reset(
    paths: NonNullable<RuntimePaths["containerRuntime"]>,
    resolvedTarget: ResolvedWorkspaceTarget,
  ): Promise<void> {
    if (await this.hasPersistentData(paths)) {
      if (this.platform !== "darwin") {
        throw new Error("The Colima container runtime can only be reset on macOS");
      }
      const colima = await this.resolve(
        "colima",
        { PATH: process.env.PATH ?? "" },
        resolvedTarget.defaultDirectory.path,
      ).catch(() => {
        throw new Error(
          "Colima is required to reset this target's Docker environment.",
        );
      });
      await this.execute(
        colima,
        ["delete", paths.profile, "--data", "--force"],
        { env: colimaEnvironment(paths), timeout: 5 * 60 * 1000 },
      );
    }
    await rm(paths.dockerConfig, { recursive: true, force: true });
    await mkdir(paths.dockerConfig, { recursive: true, mode: 0o700 });
  }

  async hasPersistentData(
    paths: NonNullable<RuntimePaths["containerRuntime"]>,
  ): Promise<boolean> {
    try {
      await lstat(join(paths.colimaHome, paths.profile));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

}

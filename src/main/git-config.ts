import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { WorkspaceDirectory } from "../shared/workspace-schema.js";
import { resolveExecutable } from "./runtime-adapters/readiness.js";

export interface GitIdentity {
  readonly name?: string;
  readonly email?: string;
}

export interface RepositoryGitIdentity {
  readonly configuredDirectory: string;
  readonly repositoryRoot: string;
  readonly gitDirectory: string;
  readonly identity: GitIdentity;
}

export interface HostGitConfiguration {
  readonly executable: string;
  readonly global: GitIdentity;
  readonly repositories: RepositoryGitIdentity[];
}

export type HostGitConfigurationInspector = (
  directories: readonly WorkspaceDirectory[],
  environment?: NodeJS.ProcessEnv,
) => Promise<HostGitConfiguration>;

export type HostGitExecutableResolver = (
  environment?: NodeJS.ProcessEnv,
) => Promise<string>;

interface GitExecutionError extends Error {
  code?: string | number;
  stderr?: string;
}

function hostGitEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  // A terminal may have launched OpsCapsule with a one-off GIT_CONFIG_* or
  // repository override. Those describe the launching command, not the user's
  // normal host identity, and must not become capsule configuration.
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => value !== undefined && !name.startsWith("GIT_"),
    ),
  );
}

async function runGit(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        env: environment,
        // Keep global includeIf evaluation independent from whatever
        // repository happened to launch the application in development.
        cwd: dirname(executable),
        maxBuffer: 64 * 1024,
        timeout: 3_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const executionError = error as GitExecutionError;
          executionError.stderr = stderr;
          reject(executionError);
          return;
        }
        resolve(stdout.replace(/\r?\n$/, ""));
      },
    );
  });
}

type MacOsDeveloperGitLocator = (
  environment: NodeJS.ProcessEnv,
) => Promise<string>;

async function locateMacOsDeveloperGit(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return runGit("/usr/bin/xcrun", ["--find", "git"], environment);
}

/**
 * Apple's /usr/bin/git is a toolchain shim. It asks xcrun to write a cache in
 * the host's Darwin user temp directory, which is intentionally outside a
 * capsule. Resolve the selected toolchain while still in the main process so
 * the capsule can execute the real binary without widening filesystem access.
 */
export async function preferDirectMacOsGitExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  locateDeveloperGit: MacOsDeveloperGitLocator = locateMacOsDeveloperGit,
): Promise<string> {
  if (platform !== "darwin" || executable !== "/usr/bin/git") {
    return executable;
  }
  const direct = await locateDeveloperGit(environment);
  if (!isAbsolute(direct) || direct === executable) {
    throw new Error("xcrun did not return a direct Git toolchain executable");
  }
  await access(direct, constants.X_OK);
  return direct;
}

export async function resolveHostGitExecutable(
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const environment = hostGitEnvironment(inheritedEnvironment);
  const executable = await resolveExecutable(
    "git",
    { PATH: environment.PATH ?? "" },
    process.cwd(),
  );
  return preferDirectMacOsGitExecutable(executable, environment);
}

async function optionalConfigValue(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const value = await runGit(executable, args, environment);
    return value || undefined;
  } catch (error) {
    // Git uses exit status 1 when a requested key is not defined. Invalid
    // configuration, timeouts, and executable failures remain visible.
    if ((error as GitExecutionError).code === 1) {
      return undefined;
    }
    throw error;
  }
}

async function identityFor(
  executable: string,
  prefix: string[],
  environment: NodeJS.ProcessEnv,
  configOptions: string[] = [],
): Promise<GitIdentity> {
  const [name, email] = await Promise.all([
    optionalConfigValue(
      executable,
      [
        ...prefix,
        "config",
        ...configOptions,
        "--includes",
        "--get",
        "user.name",
      ],
      environment,
    ),
    optionalConfigValue(
      executable,
      [
        ...prefix,
        "config",
        ...configOptions,
        "--includes",
        "--get",
        "user.email",
      ],
      environment,
    ),
  ]);
  return {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
  };
}

/**
 * Ask host Git for an allowlisted projection of its effective configuration.
 * Git resolves include/includeIf rules itself; OpsCapsule never opens the
 * user's config or any referenced file.
 */
export async function inspectHostGitConfiguration(
  directories: readonly WorkspaceDirectory[],
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<HostGitConfiguration> {
  const environment = hostGitEnvironment(inheritedEnvironment);
  let executable: string;
  try {
    executable = await resolveHostGitExecutable(environment);
  } catch {
    throw new Error(
      "A directly executable Git installation is not available in the host toolchain.",
    );
  }
  const [global, candidates] = await Promise.all([
    identityFor(executable, [], environment, ["--global"]),
    Promise.all(
      directories.map(async (directory) => {
        let repositoryRoot: string;
        let gitDirectory: string;
        try {
          [repositoryRoot, gitDirectory] = await Promise.all([
            runGit(
              executable,
              ["-C", directory.path, "rev-parse", "--show-toplevel"],
              environment,
            ),
            runGit(
              executable,
              ["-C", directory.path, "rev-parse", "--absolute-git-dir"],
              environment,
            ),
          ]);
        } catch {
          // A configured directory does not have to be a Git repository. Its
          // future repositories still receive the generated global identity.
          return undefined;
        }
        return {
          configuredDirectory: directory.path,
          repositoryRoot,
          gitDirectory,
          identity: await identityFor(
            executable,
            ["-C", directory.path],
            environment,
          ),
        } satisfies RepositoryGitIdentity;
      }),
    ),
  ]);
  const repositories: RepositoryGitIdentity[] = [];
  const seenGitDirectories = new Set<string>();

  for (const repository of candidates) {
    if (
      !repository ||
      seenGitDirectories.has(repository.gitDirectory)
    ) {
      continue;
    }
    seenGitDirectories.add(repository.gitDirectory);
    repositories.push(repository);
  }

  return { executable, global, repositories };
}

export function completeGitIdentity(identity: GitIdentity): boolean {
  return Boolean(identity.name && identity.email);
}

export function describeGitIdentity(identity: GitIdentity): string {
  if (identity.name && identity.email) {
    return `${identity.name} <${identity.email}>`;
  }
  if (identity.name) {
    return `${identity.name} (email missing)`;
  }
  if (identity.email) {
    return `${identity.email} (name missing)`;
  }
  return "No name or email configured";
}

function quotedConfigValue(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Git configuration values cannot contain NUL bytes");
  }
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")
    .replaceAll("\b", "\\b")}"`;
}

function identityConfiguration(identity: GitIdentity): string {
  if (!identity.name && !identity.email) {
    return "# No complete host Git identity was available.\n";
  }
  return [
    "[user]",
    ...(identity.name
      ? [`\tname = ${quotedConfigValue(identity.name)}`]
      : []),
    ...(identity.email
      ? [`\temail = ${quotedConfigValue(identity.email)}`]
      : []),
    "",
  ].join("\n");
}

/** Materialize only the inspected identity projection into the session root. */
export async function writeHostGitConfiguration(
  runtimeRoot: string,
  configuration: HostGitConfiguration,
): Promise<string> {
  const destination = join(runtimeRoot, "gitconfig");
  const identityDirectory = join(runtimeRoot, "git-identities");
  await mkdir(identityDirectory, { recursive: true, mode: 0o700 });

  const includes: string[] = [];
  for (const [index, repository] of configuration.repositories.entries()) {
    if (!repository.identity.name && !repository.identity.email) {
      continue;
    }
    const identityPath = join(
      identityDirectory,
      `repository-${index + 1}.gitconfig`,
    );
    await writeFile(identityPath, identityConfiguration(repository.identity), {
      encoding: "utf8",
      mode: 0o600,
    });
    // Git emits forward-slash absolute git dirs on Unix and accepts them on
    // Windows too. Normalising separators prevents backslashes being treated
    // as escapes in an includeIf condition.
    const condition = `gitdir:${repository.gitDirectory.replaceAll("\\", "/")}`;
    includes.push(
      `[includeIf ${quotedConfigValue(condition)}]`,
      `\tpath = ${quotedConfigValue(identityPath)}`,
      "",
    );
  }

  const contents = [
    "# Generated by OpsCapsule from an allowlisted host Git projection.",
    "# The source config, credential helpers, commands, hooks, and signing settings are not copied.",
    identityConfiguration(configuration.global).trimEnd(),
    ...includes,
  ].join("\n");
  await writeFile(destination, `${contents.trimEnd()}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return destination;
}

/** Put only Git, not the whole developer toolchain, at the front of PATH. */
export async function writeGitExecutableShim(
  runtimeRoot: string,
  executable: string,
): Promise<string> {
  const directory = join(runtimeRoot, "bin");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await symlink(executable, join(directory, "git"));
  return directory;
}

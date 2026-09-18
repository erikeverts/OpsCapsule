import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import type { RuntimePaths } from "../shared/contracts.js";
import type { KubernetesContext } from "../shared/workspace-schema.js";
import { CloudAdapterRegistry } from "./cloud-adapters/registry.js";
import { extractKubeconfigContext } from "./local-resources.js";
import type { ResolvedWorkspaceTarget } from "./workspace-registry.js";
import { resolveConfiguredPath } from "./workspace-registry.js";

const contextEnvironmentVariables = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "KUBECONFIG",
] as const;

function generatedKubeconfig(kubernetes: KubernetesContext): object {
  if (kubernetes.source.type !== "generated") {
    throw new Error("Expected a generated Kubernetes context");
  }
  return {
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: kubernetes.id,
        cluster: { server: kubernetes.source.server },
      },
    ],
    contexts: [
      {
        name: kubernetes.source.context,
        context: {
          cluster: kubernetes.id,
          user: kubernetes.id,
          ...(kubernetes.namespace ? { namespace: kubernetes.namespace } : {}),
        },
      },
    ],
    "current-context": kubernetes.source.context,
    users: [{ name: kubernetes.id, user: {} }],
  };
}

async function extractedKubeconfig(
  kubernetes: KubernetesContext,
  manifestSourcePath: string,
  assetDirectory: string,
): Promise<object> {
  if (kubernetes.source.type !== "kubeconfig") {
    throw new Error("Expected a kubeconfig-backed Kubernetes context");
  }
  const sourcePath = resolveConfiguredPath(
    kubernetes.source.path,
    manifestSourcePath,
  );
  return extractKubeconfigContext({
    sourcePath,
    context: kubernetes.source.context,
    namespace: kubernetes.namespace,
    assetDirectory,
  });
}

async function writeIfMissing(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Refusing unsafe target state path: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await writeFile(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  await chmod(path, 0o600);
}

async function assertStateDirectory(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Refusing unsafe target state directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await chmod(path, 0o700);
}

async function stageAwsConfig(
  source: string | undefined,
  destination: string,
): Promise<void> {
  const temporary = join(dirname(destination), `.config.${randomUUID()}.tmp`);
  try {
    if (source) {
      await copyFile(source, temporary);
      await chmod(temporary, 0o600);
    } else {
      await writeFile(temporary, "", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function prepareCloudState(
  home: string,
  targetState: string,
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<void> {
  if (resolvedTarget.cloud?.provider !== "aws") {
    return;
  }
  const awsState = join(targetState, ".aws");
  await assertStateDirectory(awsState);
  const authentication = (
    resolvedTarget.cloud.config as {
      authentication?: { configFile?: string };
    }
  ).authentication;
  const destination = join(awsState, "config");
  await stageAwsConfig(
    authentication?.configFile
      ? resolveConfiguredPath(
        authentication.configFile,
        resolvedTarget.workspace.sourcePath,
      )
      : undefined,
    destination,
  );
  await writeIfMissing(join(awsState, "credentials"));
  await symlink(
    awsState,
    join(home, ".aws"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function writeKubeconfig(
  destination: string,
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<void> {
  const { kubernetes } = resolvedTarget;
  const config = kubernetes
    ? kubernetes.source.type === "generated"
      ? generatedKubeconfig(kubernetes)
      : await extractedKubeconfig(
          kubernetes,
          resolvedTarget.workspace.sourcePath,
          join(dirname(destination), "kube-assets"),
        )
    : {
        apiVersion: "v1",
        kind: "Config",
        clusters: [],
        contexts: [],
        "current-context": "",
        users: [],
      };

  await writeFile(destination, stringify(config), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function writeShellConfiguration(
  home: string,
  workspaceName: string,
  targetName: string,
): Promise<void> {
  const prompt = `[${workspaceName} · ${targetName}]`;
  await Promise.all([
    writeFile(
      join(home, ".zshrc"),
      `PROMPT='%F{cyan}${prompt}%f %~ %# '\n`,
      { encoding: "utf8", mode: 0o600 },
    ),
    writeFile(
      join(home, ".bashrc"),
      `PS1='${prompt} \\w \\$ '\n`,
      { encoding: "utf8", mode: 0o600 },
    ),
  ]);
}

export async function createWorkspaceRuntime(
  baseDirectory: string,
  sessionId: string,
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<RuntimePaths> {
  const root = join(baseDirectory, "sessions", sessionId);
  const home = join(root, "home");
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const temp = await mkdtemp(
    join(temporaryRoot, `opscapsule-${sessionId.slice(0, 8)}-`),
  );
  const kubeconfig = join(root, "kubeconfig.yaml");
  const sandboxConfig = join(root, "sandbox.json");
  const targetState = join(
    baseDirectory,
    "state",
    "workspaces",
    resolvedTarget.workspace.manifest.metadata.id,
    "targets",
    resolvedTarget.target.id,
  );

  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(join(home, ".config"), { recursive: true, mode: 0o700 }),
    mkdir(dirname(targetState), { recursive: true, mode: 0o700 }),
  ]);
  await assertStateDirectory(targetState);
  await prepareCloudState(home, targetState, resolvedTarget);
  await Promise.all([
    writeKubeconfig(kubeconfig, resolvedTarget),
    writeShellConfiguration(
      home,
      resolvedTarget.workspace.manifest.metadata.name,
      resolvedTarget.target.name,
    ),
  ]);

  return { root, home, temp, kubeconfig, sandboxConfig, targetState };
}

export async function cleanupWorkspaceRuntime(runtime: RuntimePaths): Promise<void> {
  await Promise.all([
    rm(runtime.root, { recursive: true, force: true }),
    rm(runtime.temp, { recursive: true, force: true }),
  ]);
}

export interface CapsuleRuntime {
  runtime: RuntimePaths;
  environment: Record<string, string>;
  workingDirectory: string;
}

export async function createCapsuleRuntime(
  baseDirectory: string,
  sessionId: string,
  resolvedTarget: ResolvedWorkspaceTarget,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<CapsuleRuntime> {
  const workingDirectory = await realpath(resolvedTarget.defaultDirectory.path);
  const runtime = await createWorkspaceRuntime(
    baseDirectory,
    sessionId,
    resolvedTarget,
  );
  const environment = buildWorkspaceEnvironment(
    runtime,
    resolvedTarget,
    new CloudAdapterRegistry(),
    inheritedEnvironment,
  );
  return { runtime, environment, workingDirectory };
}

export async function cleanupStaleWorkspaceRuntimes(
  baseDirectory: string,
): Promise<void> {
  await rm(join(baseDirectory, "sessions"), { recursive: true, force: true });

  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const entries = await readdir(temporaryRoot, { withFileTypes: true });
  const currentUserId = process.getuid?.();
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && /^opscapsule-[0-9a-f]{8}-/.test(entry.name),
      )
      .map(async (entry) => {
        const path = join(temporaryRoot, entry.name);
        if (currentUserId !== undefined && (await stat(path)).uid !== currentUserId) {
          return;
        }
        await rm(path, { recursive: true, force: true });
      }),
  );
}

export function buildWorkspaceEnvironment(
  runtime: RuntimePaths,
  resolvedTarget: ResolvedWorkspaceTarget,
  cloudAdapters = new CloudAdapterRegistry(),
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(inheritedEnvironment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const variable of contextEnvironmentVariables) {
    delete environment[variable];
  }

  const cloudEnvironment = resolvedTarget.cloud
    ? cloudAdapters.environment(resolvedTarget.cloud, {
        targetState: runtime.targetState,
      })
    : {};

  return {
    ...environment,
    ...cloudEnvironment,
    HOME: runtime.home,
    ZDOTDIR: runtime.home,
    XDG_CONFIG_HOME: join(runtime.home, ".config"),
    TMPDIR: runtime.temp,
    TMP: runtime.temp,
    TEMP: runtime.temp,
    CLAUDE_CODE_TMPDIR: runtime.temp,
    KUBECONFIG: runtime.kubeconfig,
    OPSCAPSULE_WORKSPACE: resolvedTarget.workspace.manifest.metadata.id,
    OPSCAPSULE_TARGET: resolvedTarget.target.id,
    OPSCAPSULE_ENVIRONMENT: resolvedTarget.target.environment,
    ...(resolvedTarget.kubernetes
      ? {
          OPSCAPSULE_CLUSTER: resolvedTarget.kubernetes.source.context,
          OPSCAPSULE_NAMESPACE: resolvedTarget.kubernetes.namespace ?? "default",
        }
      : {}),
  };
}

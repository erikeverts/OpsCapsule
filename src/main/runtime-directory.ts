import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { parse, stringify } from "yaml";
import type { RuntimePaths } from "../shared/contracts.js";
import type { KubernetesContext } from "../shared/workspace-schema.js";
import { CloudAdapterRegistry } from "./cloud-adapters/registry.js";
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

async function stageReferencedFile(
  value: unknown,
  sourceDirectory: string,
  assetDirectory: string,
  filename: string,
): Promise<unknown> {
  if (typeof value !== "string") {
    return value;
  }
  const sourcePath = isAbsolute(value)
    ? value
    : normalize(join(sourceDirectory, value));
  const destination = join(assetDirectory, filename);
  await mkdir(assetDirectory, { recursive: true, mode: 0o700 });
  await copyFile(sourcePath, destination);
  await chmod(destination, 0o600);
  return destination;
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
  const sourceDirectory = dirname(sourcePath);
  const source = parse(await readFile(sourcePath, "utf8")) as {
    apiVersion?: string;
    kind?: string;
    clusters?: Array<{ name: string; cluster: Record<string, unknown> }>;
    contexts?: Array<{ name: string; context: Record<string, unknown> }>;
    users?: Array<{ name: string; user: Record<string, unknown> }>;
  };
  const contextEntry = source.contexts?.find(
    ({ name }) => name === kubernetes.source.context,
  );
  if (!contextEntry) {
    throw new Error(
      `Kubernetes context '${kubernetes.source.context}' was not found in ${sourcePath}`,
    );
  }
  const clusterName = String(contextEntry.context.cluster ?? "");
  const userName = String(contextEntry.context.user ?? "");
  const clusterEntry = source.clusters?.find(({ name }) => name === clusterName);
  const userEntry = source.users?.find(({ name }) => name === userName);
  if (!clusterEntry) {
    throw new Error(`Cluster '${clusterName}' was not found in ${sourcePath}`);
  }
  if (!userEntry) {
    throw new Error(`User '${userName}' was not found in ${sourcePath}`);
  }

  const cluster = { ...clusterEntry.cluster };
  cluster["certificate-authority"] = await stageReferencedFile(
    cluster["certificate-authority"],
    sourceDirectory,
    assetDirectory,
    "cluster-ca.pem",
  );
  const user = { ...userEntry.user };
  for (const [key, filename] of [
    ["client-certificate", "client-certificate.pem"],
    ["client-key", "client-key.pem"],
    ["tokenFile", "token"],
  ] as const) {
    user[key] = await stageReferencedFile(
      user[key],
      sourceDirectory,
      assetDirectory,
      filename,
    );
  }

  return {
    apiVersion: source.apiVersion ?? "v1",
    kind: source.kind ?? "Config",
    clusters: [{ ...clusterEntry, cluster }],
    contexts: [
      {
        ...contextEntry,
        context: {
          ...contextEntry.context,
          ...(kubernetes.namespace ? { namespace: kubernetes.namespace } : {}),
        },
      },
    ],
    "current-context": contextEntry.name,
    users: [{ ...userEntry, user }],
  };
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

  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(join(home, ".config"), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeKubeconfig(kubeconfig, resolvedTarget),
    writeShellConfiguration(
      home,
      resolvedTarget.workspace.manifest.metadata.name,
      resolvedTarget.target.name,
    ),
  ]);

  return { root, home, temp, kubeconfig, sandboxConfig };
}

export async function cleanupWorkspaceRuntime(runtime: RuntimePaths): Promise<void> {
  await Promise.all([
    rm(runtime.root, { recursive: true, force: true }),
    rm(runtime.temp, { recursive: true, force: true }),
  ]);
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
    ? cloudAdapters.environment(resolvedTarget.cloud)
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

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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import type { RuntimePaths } from "../shared/contracts.js";
import type { KubernetesContext } from "../shared/workspace-schema.js";
import { CloudAdapterRegistry } from "./cloud-adapters/registry.js";
import { writeBrokerHelper } from "./credentials/helper.js";
import { CredentialDeliveryRegistry } from "./credentials/delivery/registry.js";
import { OPERATIONAL_PROFILE_NAME } from "./credentials/delivery/aws.js";
import {
  applyInferenceConfiguration,
  inferenceEnvironment,
} from "./credentials/inference-configuration.js";
import type { CredentialReference } from "../shared/credentials.js";
import {
  extractKubeconfigContext,
  inspectAgentConfigurationFile,
} from "./local-resources.js";
import type { ResolvedWorkspaceTarget } from "./workspace-registry.js";
import { resolveConfiguredPath } from "./workspace-registry.js";

const inheritedEnvironmentVariables = new Set([
  "PATH",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "USER",
  "LOGNAME",
  "TZ",
  "NO_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
]);

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

  // A delivery adapter overwrites this afterwards when the target brokers an
  // AWS identity; the imported profile chain remains the fallback.
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

function assertContainedPath(root: string, candidate: string, label: string): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot.split(/[\\/]/)[0] === ".." ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`${label} escapes its managed root`);
  }
}

async function prepareAgentState(
  home: string,
  agentState: string,
  resolvedTarget: ResolvedWorkspaceTarget,
  agentInstructions?: string,
  brokerHelper?: string,
): Promise<void> {
  await assertStateDirectory(agentState);
  await Promise.all(
    ["data", "cache", "sessions"].map(async (name) => {
      await assertStateDirectory(join(agentState, name));
    }),
  );

  const { profile } = resolvedTarget.agent;
  if (profile.configuration.files.length > 0) {
    const workspaceRoot = dirname(resolvedTarget.workspace.sourcePath);
    const resourceRoot = await realpath(
      join(workspaceRoot, "resources", "agents", profile.id),
    );
    const canonicalHome = await realpath(home);
    for (const file of profile.configuration.files) {
      const source = await realpath(
        resolveConfiguredPath(file.source, resolvedTarget.workspace.sourcePath),
      );
      assertContainedPath(
        resourceRoot,
        source,
        `Agent profile '${profile.id}' configuration source '${file.source}'`,
      );
      const sourceInfo = await lstat(source);
      if (!sourceInfo.isFile()) {
        throw new Error(
          `Agent profile '${profile.id}' configuration source '${file.source}' is not a regular file`,
        );
      }
      const inspection = await inspectAgentConfigurationFile(source);
      if (inspection.warnings.some(({ category }) => category === "identity")) {
        throw new Error(
          `Agent profile '${profile.id}' configuration source '${file.source}' may override capsule-managed identity or isolation paths`,
        );
      }

      const destination = resolve(
        canonicalHome,
        ...file.destination.replaceAll("\\", "/").split("/"),
      );
      assertContainedPath(
        canonicalHome,
        destination,
        `Agent profile '${profile.id}' configuration destination '${file.destination}'`,
      );
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
      await chmod(destination, 0o600);
    }
  }

  if (profile.adapter === "opencode" && agentInstructions) {
    const destination = join(home, ".config", "opencode", "AGENTS.md");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(agentInstructions, destination);
    await chmod(destination, 0o600);
  }

  if (profile.adapter === "claude-code") {
    const claudeState = join(agentState, "data", "claude");
    const destination = join(claudeState, "CLAUDE.md");
    await assertStateDirectory(claudeState);
    if (agentInstructions) {
      await copyFile(agentInstructions, destination);
      await chmod(destination, 0o600);
    } else {
      await rm(destination, { force: true });
    }
  }

  // Written after managed configuration is copied, so the capsule's inference
  // selection is merged into whatever the profile imported rather than being
  // overwritten by it.
  if (resolvedTarget.credentials.inference) {
    await applyInferenceConfiguration({
      home,
      agentState,
      adapter: profile.adapter,
      reference: resolvedTarget.credentials.inference,
      helperPath: brokerHelper,
    });
  }
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
  /**
   * Supplied by the main process so materialize-based delivery can read a
   * stored secret. Left undefined by callers that only use pull-based
   * delivery, which never reads one.
   */
  readSecret?: (reference: CredentialReference) => Promise<string>,
): Promise<RuntimePaths> {
  const root = join(baseDirectory, "sessions", sessionId);
  const home = join(root, "home");
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const temp = await mkdtemp(
    join(temporaryRoot, `opscapsule-${sessionId.slice(0, 8)}-`),
  );
  const kubeconfig = join(root, "kubeconfig.yaml");
  const sandboxConfig = join(root, "sandbox.json");
  const agentInstructions = resolvedTarget.workspace.manifest.agentInstructions
    ? join(root, "agent-instructions.md")
    : undefined;
  const targetState = join(
    baseDirectory,
    "state",
    "workspaces",
    resolvedTarget.workspace.manifest.metadata.id,
    "targets",
    resolvedTarget.target.id,
  );
  const agentState = join(
    targetState,
    "agents",
    resolvedTarget.agent.profile.id,
  );

  // A capsule only gets a channel to the main process when a delivery adapter
  // actually pulls. Credentials that are materialized at launch, such as a
  // provider OAuth token, need no channel, so a capsule using only those keeps
  // allowUnixSockets empty and opens no hole in the sandbox.
  const delivery = new CredentialDeliveryRegistry();
  const assignments = [
    resolvedTarget.credentials.operational
      ? { role: "operational" as const, reference: resolvedTarget.credentials.operational }
      : undefined,
    resolvedTarget.credentials.inference
      ? { role: "inference" as const, reference: resolvedTarget.credentials.inference }
      : undefined,
  ].filter((assignment) => assignment !== undefined);
  const needsBrokerChannel = delivery.requiresBrokerChannel(
    assignments.map(({ reference }) => reference),
  );
  // The socket lives in the session temp directory, not under the session
  // root. A unix socket path is limited to 104 bytes on macOS, and
  // "<userData>/sessions/<uuid>/broker.sock" already exceeds that under the
  // real Application Support path, which fails at listen() with EINVAL.
  const brokerSocket = needsBrokerChannel ? join(temp, "broker.sock") : undefined;
  // The helper also lives in the temp path. credential_process and
  // awsCredentialExport are parsed as command lines, so a path containing
  // spaces - which "~/Library/Application Support" always does - is split and
  // the command is never found.
  const brokerHelper = needsBrokerChannel ? join(temp, "broker") : undefined;

  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(join(home, ".config"), { recursive: true, mode: 0o700 }),
    mkdir(dirname(targetState), { recursive: true, mode: 0o700 }),
  ]);
  await assertStateDirectory(targetState);
  if (agentInstructions) {
    await writeFile(
      agentInstructions,
      resolvedTarget.workspace.manifest.agentInstructions!,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  if (brokerHelper && brokerSocket) {
    await writeBrokerHelper(brokerHelper, brokerSocket);
  }
  await prepareCloudState(home, targetState, resolvedTarget);
  await prepareAgentState(
    home,
    agentState,
    resolvedTarget,
    agentInstructions,
    brokerHelper,
  );
  if (assignments.length > 0) {
    await delivery.prepare({
      helperPath: brokerHelper,
      targetState,
      agentState,
      assignments,
      readSecret:
        readSecret ??
        (async (reference) => {
          throw new Error(
            `No credential reader is available for '${reference.id}'.`,
          );
        }),
    });
  }
  await Promise.all([
    writeKubeconfig(kubeconfig, resolvedTarget),
    writeShellConfiguration(
      home,
      resolvedTarget.workspace.manifest.metadata.name,
      resolvedTarget.target.name,
    ),
  ]);

  return {
    root,
    home,
    temp,
    kubeconfig,
    sandboxConfig,
    targetState,
    agentState,
    ...(agentInstructions ? { agentInstructions } : {}),
    ...(brokerSocket ? { brokerSocket } : {}),
    ...(brokerHelper ? { brokerHelper } : {}),
  };
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
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (inheritedEnvironmentVariables.has(entry[0]) ||
          entry[0].startsWith("LC_")),
    ),
  );

  const cloudEnvironment = resolvedTarget.cloud
    ? cloudAdapters.environment(resolvedTarget.cloud, {
        targetState: runtime.targetState,
      })
    : {};

  // A brokered operational identity is written as the default profile, so the
  // environment has to name it. Without this the capsule keeps pointing at the
  // imported cloud profile and never reaches the broker.
  const brokeredAws: Record<string, string> =
    resolvedTarget.credentials.operational?.kind.startsWith("aws")
      ? { AWS_PROFILE: OPERATIONAL_PROFILE_NAME }
      : {};

  // When AWS identities are brokered without a cloud connection there is no
  // cloud adapter to point the SDK at the capsule's config file.
  const brokeredAwsPaths: Record<string, string> =
    !resolvedTarget.cloud &&
    (resolvedTarget.credentials.operational ?? resolvedTarget.credentials.inference)
      ? {
          AWS_CONFIG_FILE: join(runtime.targetState, ".aws", "config"),
          AWS_SHARED_CREDENTIALS_FILE: join(
            runtime.targetState,
            ".aws",
            "credentials",
          ),
        }
      : {};

  return {
    ...environment,
    ...cloudEnvironment,
    ...brokeredAwsPaths,
    ...brokeredAws,
    ...inferenceEnvironment(resolvedTarget.credentials.inference),
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
    ...(runtime.agentInstructions
      ? { OPSCAPSULE_AGENT_INSTRUCTIONS: runtime.agentInstructions }
      : {}),
    ...(resolvedTarget.kubernetes
      ? {
          OPSCAPSULE_CLUSTER: resolvedTarget.kubernetes.source.context,
          OPSCAPSULE_NAMESPACE: resolvedTarget.kubernetes.namespace ?? "default",
        }
      : {}),
  };
}

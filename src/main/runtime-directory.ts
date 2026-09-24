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
import {
  buildCapsuleAwsConfig,
  writeBrokerHelper,
} from "./credentials/helper.js";
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
  brokerHelperPath?: string,
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

  const { operational, inference } = resolvedTarget.credentials;
  if (brokerHelperPath && (operational || inference)) {
    // Brokered identities replace the imported profile chain: credentials are
    // fetched from the main process at point of use instead of resolved from
    // anything stored inside the capsule.
    await writeFile(
      destination,
      buildCapsuleAwsConfig({
        helperPath: brokerHelperPath,
        operational,
        inference,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  } else {
    await stageAwsConfig(
      authentication?.configFile
        ? resolveConfiguredPath(
          authentication.configFile,
          resolvedTarget.workspace.sourcePath,
        )
        : undefined,
      destination,
    );
  }
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

  // A capsule only gets a channel to the main process when it actually has
  // brokered credentials. Otherwise no socket and no helper exist at all.
  const brokersCredentials = Boolean(
    resolvedTarget.credentials.operational ?? resolvedTarget.credentials.inference,
  );
  const brokerSocket = brokersCredentials ? join(root, "broker.sock") : undefined;
  const brokerHelper = brokersCredentials ? join(root, "broker") : undefined;

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
  await prepareCloudState(home, targetState, resolvedTarget, brokerHelper);
  await prepareAgentState(home, agentState, resolvedTarget, agentInstructions);
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

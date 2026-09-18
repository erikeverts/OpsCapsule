import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { parse, stringify } from "yaml";
import { ZodError } from "zod";
import type {
  WorkspaceCatalog,
  WorkspaceCatalogEntry,
  WorkspaceDocument,
  WorkspaceTargetSummary,
} from "../shared/contracts.js";
import {
  parseWorkspaceManifest,
  type CloudConnection,
  type AgentProfile,
  type KubernetesContext,
  type WorkspaceDirectory,
  type WorkspaceManifest,
  type WorkspaceTarget,
} from "../shared/workspace-schema.js";
import { CloudAdapterRegistry } from "./cloud-adapters/registry.js";
import { seedDefaultWorkspaces } from "./default-workspaces.js";
import {
  extractAwsProfile,
  writeExtractedKubeconfig,
} from "./local-resources.js";

export interface LoadedWorkspace {
  manifest: WorkspaceManifest;
  sourcePath: string;
}

export interface ResolvedWorkspaceTarget {
  workspace: LoadedWorkspace;
  target: WorkspaceTarget;
  cloud?: CloudConnection;
  kubernetes?: KubernetesContext;
  directories: WorkspaceDirectory[];
  defaultDirectory: WorkspaceDirectory;
  agent: ResolvedAgentProfile;
  summary: WorkspaceTargetSummary;
}

export interface ResolvedAgentProfile {
  profile: AgentProfile;
  legacy: boolean;
}

function describeError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function contentRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function serializeManifest(manifest: WorkspaceManifest): string {
  return stringify(manifest, { lineWidth: 0 });
}

function assertManagedAgentResourcePaths(
  manifest: WorkspaceManifest,
  sourcePath: string,
): void {
  const workspaceRoot = dirname(sourcePath);
  for (const profile of manifest.agentProfiles) {
    const profileRoot = join(workspaceRoot, "resources", "agents", profile.id);
    for (const file of profile.configuration.files) {
      const source = resolveConfiguredPath(file.source, sourcePath);
      const pathFromProfile = relative(profileRoot, source);
      if (
        pathFromProfile.split(/[\\/]/)[0] === ".." ||
        isAbsolute(pathFromProfile)
      ) {
        throw new Error(
          `Agent profile '${profile.id}' configuration source '${file.source}' is outside its managed resource directory`,
        );
      }
    }
  }
}

export function resolveConfiguredPath(
  configuredPath: string,
  sourcePath: string,
): string {
  if (configuredPath === "~") {
    return homedir();
  }
  if (configuredPath.startsWith("~/")) {
    return normalize(join(homedir(), configuredPath.slice(2)));
  }
  if (isAbsolute(configuredPath)) {
    return normalize(configuredPath);
  }
  return resolve(dirname(sourcePath), configuredPath);
}

export class WorkspaceRegistry {
  readonly configDirectory: string;
  readonly stateDirectory: string;
  private readonly demoRoot: string;

  constructor(
    baseDirectory: string,
    private readonly cloudAdapters = new CloudAdapterRegistry(),
  ) {
    this.configDirectory = join(baseDirectory, "config", "workspaces");
    this.stateDirectory = join(baseDirectory, "state", "workspaces");
    this.demoRoot = join(baseDirectory, "demo-workspaces");
  }

  async initialize(): Promise<void> {
    await seedDefaultWorkspaces(this.configDirectory, this.demoRoot);
  }

  async catalog(): Promise<WorkspaceCatalog> {
    const { workspaces, errors } = await this.loadAll();
    return {
      configDirectory: this.configDirectory,
      workspaces: workspaces.map((workspace) => this.summarize(workspace)),
      errors,
    };
  }

  async document(workspaceId: string): Promise<WorkspaceDocument> {
    const workspace = await this.findWorkspace(workspaceId);
    const yaml = await readFile(workspace.sourcePath, "utf8");
    return {
      manifest: workspace.manifest,
      sourcePath: workspace.sourcePath,
      revision: contentRevision(yaml),
      yaml,
    };
  }

  async create(input: unknown): Promise<WorkspaceDocument> {
    const manifest = this.validateForEditor(input, "new workspace");
    const { workspaces } = await this.loadAll();
    if (
      workspaces.some(
        ({ manifest: existing }) =>
          existing.metadata.id === manifest.metadata.id,
      )
    ) {
      throw new Error(`Workspace '${manifest.metadata.id}' already exists`);
    }

    const workspaceRoot = join(this.configDirectory, manifest.metadata.id);
    const sourcePath = join(workspaceRoot, "workspace.yaml");
    const temporaryRoot = join(
      this.configDirectory,
      `.${manifest.metadata.id}.${randomUUID()}.tmp`,
    );
    await mkdir(temporaryRoot, { mode: 0o700 });
    try {
      const materialized = await this.materializeResources(
        manifest,
        undefined,
        temporaryRoot,
      );
      this.validateForEditor(materialized, sourcePath);
      const yaml = serializeManifest(materialized);
      await writeFile(join(temporaryRoot, "workspace.yaml"), yaml, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryRoot, workspaceRoot);
      return {
        manifest: materialized,
        sourcePath,
        revision: contentRevision(yaml),
        yaml,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Workspace directory '${manifest.metadata.id}' already exists`);
      }
      throw error;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async save(
    workspaceId: string,
    expectedRevision: string,
    input: unknown,
  ): Promise<WorkspaceDocument> {
    const workspace = await this.findWorkspace(workspaceId);
    const currentYaml = await readFile(workspace.sourcePath, "utf8");
    if (contentRevision(currentYaml) !== expectedRevision) {
      throw new Error(
        "This workspace changed on disk after it was opened. Reload it before saving so those changes are not overwritten.",
      );
    }

    const manifest = this.validateForEditor(input, workspace.sourcePath);
    if (manifest.metadata.id !== workspaceId) {
      throw new Error("A workspace id cannot be changed after creation");
    }
    const managedSourcePath = join(
      this.configDirectory,
      workspaceId,
      "workspace.yaml",
    );
    if (workspace.sourcePath !== managedSourcePath) {
      return this.migrateLegacyWorkspace(workspace, manifest, managedSourcePath);
    }

    const materialized = await this.materializeResources(
      manifest,
      workspace.sourcePath,
      dirname(workspace.sourcePath),
    );
    const yaml = serializeManifest(materialized);
    const temporaryPath = await this.writeTemporaryManifest(workspace.sourcePath, yaml);
    try {
      await rename(temporaryPath, workspace.sourcePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }

    return {
      manifest: materialized,
      sourcePath: workspace.sourcePath,
      revision: contentRevision(yaml),
      yaml,
    };
  }

  async deleteWorkspace(
    workspaceId: string,
    expectedRevision: string,
  ): Promise<void> {
    const workspace = await this.findWorkspace(workspaceId);
    const currentYaml = await readFile(workspace.sourcePath, "utf8");
    if (contentRevision(currentYaml) !== expectedRevision) {
      throw new Error(
        "This workspace changed on disk after it was opened. Reload it before deleting so a newer configuration is not removed.",
      );
    }

    const managedSourcePath = join(
      this.configDirectory,
      workspaceId,
      "workspace.yaml",
    );
    const workspaceConfiguration =
      workspace.sourcePath === managedSourcePath
        ? dirname(workspace.sourcePath)
        : workspace.sourcePath;

    await rm(workspaceConfiguration, {
      recursive: workspace.sourcePath === managedSourcePath,
      force: false,
    });
    await rm(join(this.stateDirectory, workspaceId), {
      recursive: true,
      force: true,
    });
  }

  async resolveTarget(
    workspaceId: string,
    targetId: string,
  ): Promise<ResolvedWorkspaceTarget> {
    const { workspaces } = await this.loadAll();
    const workspace = workspaces.find(
      ({ manifest }) => manifest.metadata.id === workspaceId,
    );
    if (!workspace) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    const target = workspace.manifest.targets.find(({ id }) => id === targetId);
    if (!target) {
      throw new Error(`Unknown target '${targetId}' in workspace '${workspaceId}'`);
    }
    return this.resolve(workspace, target);
  }

  async resolveAgentConfigurationPath(
    workspaceId: string,
    configuredPath: string,
  ): Promise<string> {
    const workspace = await this.findWorkspace(workspaceId);
    const declared = workspace.manifest.agentProfiles.some((profile) =>
      profile.configuration.files.some(({ source }) => source === configuredPath),
    );
    if (!declared) {
      throw new Error("The file is not declared by this workspace");
    }
    return resolveConfiguredPath(configuredPath, workspace.sourcePath);
  }

  private async findWorkspace(workspaceId: string): Promise<LoadedWorkspace> {
    const { workspaces } = await this.loadAll();
    const workspace = workspaces.find(
      ({ manifest }) => manifest.metadata.id === workspaceId,
    );
    if (!workspace) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    return workspace;
  }

  private validateForEditor(
    input: unknown,
    sourcePath: string,
  ): WorkspaceManifest {
    const manifest = parseWorkspaceManifest(input);
    for (const connection of manifest.cloudConnections) {
      this.cloudAdapters.summarize(connection);
    }
    this.summarize({ manifest, sourcePath });
    return manifest;
  }

  private async writeTemporaryManifest(
    destination: string,
    content: string,
  ): Promise<string> {
    const temporaryPath = join(
      dirname(destination),
      `.${basename(destination)}.${randomUUID()}.tmp`,
    );
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return temporaryPath;
  }

  private async migrateLegacyWorkspace(
    workspace: LoadedWorkspace,
    manifest: WorkspaceManifest,
    destination: string,
  ): Promise<WorkspaceDocument> {
    const destinationRoot = dirname(destination);
    const rebasedManifest = structuredClone(manifest);
    for (const directory of rebasedManifest.directories) {
      if (
        !isAbsolute(directory.path) &&
        directory.path !== "~" &&
        !directory.path.startsWith("~/")
      ) {
        directory.path = relative(
          destinationRoot,
          resolveConfiguredPath(directory.path, workspace.sourcePath),
        );
      }
    }
    const temporaryRoot = join(
      this.configDirectory,
      `.${manifest.metadata.id}.${randomUUID()}.tmp`,
    );
    let installed = false;
    await mkdir(temporaryRoot, { mode: 0o700 });
    try {
      const materialized = await this.materializeResources(
        rebasedManifest,
        workspace.sourcePath,
        temporaryRoot,
      );
      const yaml = serializeManifest(materialized);
      await writeFile(join(temporaryRoot, "workspace.yaml"), yaml, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryRoot, destinationRoot);
      installed = true;
      try {
        await rm(workspace.sourcePath);
      } catch (error) {
        await rm(destinationRoot, { recursive: true, force: true });
        installed = false;
        throw error;
      }
      return {
        manifest: materialized,
        sourcePath: destination,
        revision: contentRevision(yaml),
        yaml,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Workspace directory '${manifest.metadata.id}' already exists`);
      }
      throw error;
    } finally {
      if (!installed) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  }

  private async materializeResources(
    input: WorkspaceManifest,
    sourceManifest: string | undefined,
    destinationRoot: string,
  ): Promise<WorkspaceManifest> {
    const manifest = structuredClone(input);
    for (const kubernetes of manifest.kubernetesContexts) {
      if (kubernetes.source.type !== "kubeconfig") {
        continue;
      }
      const destination = join(
        destinationRoot,
        "resources",
        "kubernetes",
        kubernetes.id,
        "config.yaml",
      );
      const source = sourceManifest
        ? resolveConfiguredPath(kubernetes.source.path, sourceManifest)
        : isAbsolute(kubernetes.source.path)
          ? normalize(kubernetes.source.path)
          : undefined;
      if (!source) {
        throw new Error(
          `Kubernetes context '${kubernetes.id}' must be imported from an absolute kubeconfig path`,
        );
      }
      if (normalize(source) !== normalize(destination)) {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeExtractedKubeconfig({
          sourcePath: source,
          context: kubernetes.source.context,
          namespace: kubernetes.namespace,
          destination,
        });
      }
      kubernetes.source.path = relative(destinationRoot, destination);
    }

    for (const connection of manifest.cloudConnections) {
      if (connection.provider !== "aws") {
        continue;
      }
      const authentication = (
        connection.config as {
          authentication?: {
            type?: string;
            profile?: string;
            configFile?: string;
          };
        }
      ).authentication;
      if (!authentication?.configFile || !authentication.profile) {
        continue;
      }
      const destination = join(
        destinationRoot,
        "resources",
        "cloud",
        connection.id,
        "config",
      );
      const source = sourceManifest
        ? resolveConfiguredPath(authentication.configFile, sourceManifest)
        : isAbsolute(authentication.configFile)
          ? normalize(authentication.configFile)
          : undefined;
      if (!source) {
        throw new Error(
          `AWS connection '${connection.id}' must be imported from an absolute config path`,
        );
      }
      if (normalize(source) !== normalize(destination)) {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(
          destination,
          await extractAwsProfile(source, authentication.profile),
          { encoding: "utf8", mode: 0o600 },
        );
      }
      authentication.configFile = relative(destinationRoot, destination);
    }

    for (const profile of manifest.agentProfiles) {
      const managedNames = new Set<string>();
      for (const file of profile.configuration.files) {
        const source = sourceManifest
          ? resolveConfiguredPath(file.source, sourceManifest)
          : isAbsolute(file.source)
            ? normalize(file.source)
            : undefined;
        if (!source) {
          throw new Error(
            `Agent profile '${profile.id}' configuration must be imported from an absolute path`,
          );
        }
        const filename = basename(source);
        if (managedNames.has(filename)) {
          throw new Error(
            `Agent profile '${profile.id}' has multiple configuration files named '${filename}'`,
          );
        }
        managedNames.add(filename);
        const destination = join(
          destinationRoot,
          "resources",
          "agents",
          profile.id,
          filename,
        );
        if (normalize(source) !== normalize(destination)) {
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          const temporaryDestination = join(
            dirname(destination),
            `.${filename}.${randomUUID()}.tmp`,
          );
          try {
            await copyFile(source, temporaryDestination);
            await chmod(temporaryDestination, 0o600);
            await rename(temporaryDestination, destination);
          } finally {
            await rm(temporaryDestination, { force: true });
          }
        } else {
          const existing = await lstat(destination);
          if (!existing.isFile() || existing.isSymbolicLink()) {
            throw new Error(
              `Agent profile '${profile.id}' managed configuration '${filename}' is not a regular file`,
            );
          }
        }
        await chmod(destination, 0o600);
        file.source = relative(destinationRoot, destination).replaceAll("\\", "/");
      }
    }
    return manifest;
  }

  private async loadAll(): Promise<{
    workspaces: LoadedWorkspace[];
    errors: Array<{ sourcePath: string; message: string }>;
  }> {
    const entries = await readdir(this.configDirectory, { withFileTypes: true });
    const files = entries
      .flatMap((entry) => {
        if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
          return [join(this.configDirectory, entry.name)];
        }
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          return [join(this.configDirectory, entry.name, "workspace.yaml")];
        }
        return [];
      })
      .sort();
    const workspaces: LoadedWorkspace[] = [];
    const errors: Array<{ sourcePath: string; message: string }> = [];
    const workspaceIds = new Set<string>();

    for (const sourcePath of files) {
      try {
        const document = parse(await readFile(sourcePath, "utf8"));
        const manifest = this.validateForEditor(document, sourcePath);
        assertManagedAgentResourcePaths(manifest, sourcePath);
        if (workspaceIds.has(manifest.metadata.id)) {
          throw new Error(`Duplicate workspace id '${manifest.metadata.id}'`);
        }
        workspaceIds.add(manifest.metadata.id);
        const loaded = { manifest, sourcePath };
        this.summarize(loaded);
        workspaces.push(loaded);
      } catch (error) {
        errors.push({ sourcePath, message: describeError(error) });
      }
    }

    return { workspaces, errors };
  }

  private summarize(workspace: LoadedWorkspace): WorkspaceCatalogEntry {
    return {
      id: workspace.manifest.metadata.id,
      name: workspace.manifest.metadata.name,
      description: workspace.manifest.metadata.description,
      sourcePath: workspace.sourcePath,
      targets: workspace.manifest.targets.map(
        (target) => this.resolve(workspace, target).summary,
      ),
    };
  }

  private resolve(
    workspace: LoadedWorkspace,
    target: WorkspaceTarget,
  ): ResolvedWorkspaceTarget {
    const cloud = target.cloudConnection
      ? workspace.manifest.cloudConnections.find(
          ({ id }) => id === target.cloudConnection,
        )
      : undefined;
    const kubernetes = target.kubernetesContext
      ? workspace.manifest.kubernetesContexts.find(
          ({ id }) => id === target.kubernetesContext,
        )
      : undefined;
    const directories = target.directories.map((directoryId) => {
      const directory = workspace.manifest.directories.find(
        ({ id }) => id === directoryId,
      );
      if (!directory) {
        throw new Error(`Unknown directory '${directoryId}'`);
      }
      return {
        ...directory,
        path: resolveConfiguredPath(directory.path, workspace.sourcePath),
      };
    });
    const defaultDirectory = directories.find(
      ({ id }) => id === target.defaultDirectory,
    );
    if (!defaultDirectory) {
      throw new Error(`Unknown default directory '${target.defaultDirectory}'`);
    }

    const selectedAgentProfile =
      target.agentProfile ?? workspace.manifest.defaultAgentProfile;
    const configuredAgent = selectedAgentProfile
      ? workspace.manifest.agentProfiles.find(({ id }) => id === selectedAgentProfile)
      : undefined;
    const agent: ResolvedAgentProfile | undefined = configuredAgent
      ? { profile: configuredAgent, legacy: false }
      : target.agentRuntime
        ? {
            profile: {
              id: "legacy",
              name: "Legacy target command",
              adapter: "command",
              runtime: {
                command: target.agentRuntime.command,
                args: target.agentRuntime.args,
              },
              configuration: { files: [] },
              environment: {},
            },
            legacy: true,
          }
        : undefined;
    if (!agent) {
      throw new Error(`Target '${target.id}' does not resolve an agent profile`);
    }

    const summary: WorkspaceTargetSummary = {
      id: target.id,
      name: target.name,
      environment: target.environment,
      risk: target.risk,
      cloud: cloud ? this.cloudAdapters.summarize(cloud) : undefined,
      kubernetes: kubernetes
        ? {
            id: kubernetes.id,
            name: kubernetes.name,
            context: kubernetes.source.context,
            namespace: kubernetes.namespace,
          }
        : undefined,
      directories,
      defaultDirectory: defaultDirectory.path,
      agent: {
        id: agent.profile.id,
        name: agent.profile.name,
        adapter: agent.profile.adapter,
        command: agent.profile.runtime.command,
        legacy: agent.legacy,
      },
      isolationMode: target.isolation.mode,
      networkMode: target.isolation.network.mode,
    };

    return {
      workspace,
      target,
      cloud,
      kubernetes,
      directories,
      defaultDirectory,
      agent,
      summary,
    };
  }
}

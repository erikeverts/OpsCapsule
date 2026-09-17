import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import type {
  WorkspaceCatalog,
  WorkspaceCatalogEntry,
  WorkspaceTargetSummary,
} from "../shared/contracts.js";
import {
  workspaceManifestSchema,
  type CloudConnection,
  type KubernetesContext,
  type WorkspaceDirectory,
  type WorkspaceManifest,
  type WorkspaceTarget,
} from "../shared/workspace-schema.js";
import { CloudAdapterRegistry } from "./cloud-adapters/registry.js";
import { seedDefaultWorkspaces } from "./default-workspaces.js";

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
  summary: WorkspaceTargetSummary;
}

function describeError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function assertUniqueIds(
  values: Array<{ id: string }>,
  collectionName: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new Error(`Duplicate ${collectionName} id '${value.id}'`);
    }
    seen.add(value.id);
  }
}

function validateReferences(manifest: WorkspaceManifest): void {
  assertUniqueIds(manifest.cloudConnections, "cloud connection");
  assertUniqueIds(manifest.kubernetesContexts, "Kubernetes context");
  assertUniqueIds(manifest.directories, "directory");
  assertUniqueIds(manifest.targets, "target");

  const cloudIds = new Set(manifest.cloudConnections.map(({ id }) => id));
  const kubernetesIds = new Set(
    manifest.kubernetesContexts.map(({ id }) => id),
  );
  const directoryIds = new Set(manifest.directories.map(({ id }) => id));

  for (const target of manifest.targets) {
    if (target.cloudConnection && !cloudIds.has(target.cloudConnection)) {
      throw new Error(
        `Target '${target.id}' references unknown cloud connection '${target.cloudConnection}'`,
      );
    }
    if (
      target.kubernetesContext &&
      !kubernetesIds.has(target.kubernetesContext)
    ) {
      throw new Error(
        `Target '${target.id}' references unknown Kubernetes context '${target.kubernetesContext}'`,
      );
    }
    for (const directoryId of target.directories) {
      if (!directoryIds.has(directoryId)) {
        throw new Error(
          `Target '${target.id}' references unknown directory '${directoryId}'`,
        );
      }
    }
    if (!target.directories.includes(target.defaultDirectory)) {
      throw new Error(
        `Target '${target.id}' default directory must also appear in its directories list`,
      );
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
  private readonly demoRoot: string;

  constructor(
    baseDirectory: string,
    private readonly cloudAdapters = new CloudAdapterRegistry(),
  ) {
    this.configDirectory = join(baseDirectory, "config", "workspaces");
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

  private async loadAll(): Promise<{
    workspaces: LoadedWorkspace[];
    errors: Array<{ sourcePath: string; message: string }>;
  }> {
    const files = (await readdir(this.configDirectory))
      .filter((file) => /\.ya?ml$/i.test(file))
      .sort();
    const workspaces: LoadedWorkspace[] = [];
    const errors: Array<{ sourcePath: string; message: string }> = [];
    const workspaceIds = new Set<string>();

    for (const file of files) {
      const sourcePath = join(this.configDirectory, file);
      try {
        const document = parse(await readFile(sourcePath, "utf8"));
        const manifest = workspaceManifestSchema.parse(document);
        validateReferences(manifest);
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
      agentRuntime: target.agentRuntime,
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
      summary,
    };
  }
}


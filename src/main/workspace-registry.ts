import { createHash, randomUUID } from "node:crypto";
import {
  link,
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

function contentRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function serializeManifest(manifest: WorkspaceManifest): string {
  return stringify(manifest, { lineWidth: 0 });
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

    const sourcePath = join(
      this.configDirectory,
      `${manifest.metadata.id}.yaml`,
    );
    this.validateForEditor(manifest, sourcePath);
    const yaml = serializeManifest(manifest);
    const temporaryPath = await this.writeTemporaryManifest(sourcePath, yaml);
    try {
      await link(temporaryPath, sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Manifest file '${basename(sourcePath)}' already exists`);
      }
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }

    return {
      manifest,
      sourcePath,
      revision: contentRevision(yaml),
      yaml,
    };
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
    const yaml = serializeManifest(manifest);
    const temporaryPath = await this.writeTemporaryManifest(
      workspace.sourcePath,
      yaml,
    );
    try {
      await rename(temporaryPath, workspace.sourcePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }

    return {
      manifest,
      sourcePath: workspace.sourcePath,
      revision: contentRevision(yaml),
      yaml,
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
        const manifest = this.validateForEditor(document, sourcePath);
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

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, type PlatformPath } from "node:path";
import { stringify } from "yaml";
import type { WorkspaceManifest } from "../shared/workspace-schema.js";

function atlasWorkspace(demoRoot: string, path: PlatformPath): WorkspaceManifest {
  return {
    apiVersion: "opscapsule.dev/v1alpha1",
    kind: "Workspace",
    metadata: {
      id: "atlas",
      name: "Atlas Retail",
      description: "Example workspace with separate non-production and production targets.",
    },
    cloudConnections: [
      {
        id: "aws-nonprod",
        name: "AWS non-production",
        provider: "aws",
        config: {
          authentication: { type: "profile", profile: "atlas-nonprod" },
          expectedIdentity: { accountId: "111122223333" },
          defaults: { region: "eu-west-1" },
        },
      },
      {
        id: "aws-production",
        name: "AWS production",
        provider: "aws",
        config: {
          authentication: { type: "profile", profile: "atlas-prod" },
          expectedIdentity: { accountId: "999900001111" },
          defaults: { region: "eu-west-1" },
        },
      },
    ],
    kubernetesContexts: [
      {
        id: "development",
        name: "Development EKS",
        namespace: "platform-dev",
        source: {
          type: "generated",
          server: "https://atlas-development.invalid",
          context: "atlas-development",
        },
      },
      {
        id: "production",
        name: "Production EKS",
        namespace: "platform",
        source: {
          type: "generated",
          server: "https://atlas-production.invalid",
          context: "atlas-production",
        },
      },
    ],
    directories: [
      {
        id: "application",
        name: "Application",
        path: path.join(demoRoot, "atlas", "application"),
        access: "read-write",
      },
      {
        id: "documentation",
        name: "Documentation",
        path: path.join(demoRoot, "atlas", "documentation"),
        access: "read-only",
      },
    ],
    targets: [
      {
        id: "development",
        name: "Development",
        environment: "development",
        risk: "development",
        cloudConnection: "aws-nonprod",
        kubernetesContext: "development",
        directories: ["application", "documentation"],
        defaultDirectory: "application",
        agentRuntime: { adapter: "command", command: "$SHELL", args: [] },
        isolation: {
          mode: "enforced",
          network: { mode: "public", allowedDomains: [] },
        },
      },
      {
        id: "production",
        name: "Production",
        environment: "production",
        risk: "production",
        cloudConnection: "aws-production",
        kubernetesContext: "production",
        directories: ["application", "documentation"],
        defaultDirectory: "application",
        agentRuntime: { adapter: "command", command: "$SHELL", args: [] },
        isolation: {
          mode: "enforced",
          network: { mode: "public", allowedDomains: [] },
        },
      },
    ],
  };
}

function borealisWorkspace(demoRoot: string, path: PlatformPath): WorkspaceManifest {
  return {
    apiVersion: "opscapsule.dev/v1alpha1",
    kind: "Workspace",
    metadata: {
      id: "borealis",
      name: "Borealis Health",
      description: "Example staging workspace.",
    },
    cloudConnections: [
      {
        id: "aws-staging",
        name: "AWS staging",
        provider: "aws",
        config: {
          authentication: { type: "profile", profile: "borealis-stage" },
          expectedIdentity: { accountId: "444455556666" },
          defaults: { region: "eu-central-1" },
        },
      },
    ],
    kubernetesContexts: [
      {
        id: "staging",
        name: "Staging EKS",
        namespace: "services",
        source: {
          type: "generated",
          server: "https://borealis-staging.invalid",
          context: "borealis-staging",
        },
      },
    ],
    directories: [
      {
        id: "operations",
        name: "Operations",
        path: path.join(demoRoot, "borealis", "operations"),
        access: "read-write",
      },
    ],
    targets: [
      {
        id: "staging",
        name: "Staging",
        environment: "staging",
        risk: "staging",
        cloudConnection: "aws-staging",
        kubernetesContext: "staging",
        directories: ["operations"],
        defaultDirectory: "operations",
        agentRuntime: { adapter: "command", command: "$SHELL", args: [] },
        isolation: {
          mode: "enforced",
          network: { mode: "public", allowedDomains: [] },
        },
      },
    ],
  };
}

export function demoDirectories(demoRoot: string, path: PlatformPath): string[] {
  return [
    path.join(demoRoot, "atlas", "application"),
    path.join(demoRoot, "atlas", "documentation"),
    path.join(demoRoot, "borealis", "operations"),
  ];
}

// Runs on the execution host, which may differ from the Electron host.
export async function createDemoDirectories(directories: string[]): Promise<void> {
  await Promise.all(
    directories.map((directory) => mkdir(directory, { recursive: true })),
  );
  await Promise.all(
    directories.map((directory) =>
      writeFile(
        join(directory, "README.md"),
        "# Demo directory\n\nThis directory was created by the OpsCapsule iteration 2 example.\n",
        { encoding: "utf8", flag: "wx" },
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }),
    ),
  );
}

export interface DemoSeedingOptions {
  demoRoot: string;
  path: PlatformPath;
  createDemoDirectories: (directories: string[]) => Promise<void>;
}

export async function seedDefaultWorkspaces(
  configDirectory: string,
  options: DemoSeedingOptions,
): Promise<void> {
  await mkdir(configDirectory, { recursive: true });
  const existingFiles = await readdir(configDirectory);
  if (existingFiles.length > 0) {
    return;
  }

  await options.createDemoDirectories(
    demoDirectories(options.demoRoot, options.path),
  );

  const manifests = [
    ["atlas", atlasWorkspace(options.demoRoot, options.path)],
    ["borealis", borealisWorkspace(options.demoRoot, options.path)],
  ] as const;

  await Promise.all(
    manifests.map(async ([workspaceId, manifest]) => {
      const workspaceDirectory = join(configDirectory, workspaceId);
      await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(workspaceDirectory, "workspace.yaml"),
        stringify(manifest),
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") {
          throw error;
        }
      });
    }),
  );
}

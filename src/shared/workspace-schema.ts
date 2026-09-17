import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Use lowercase letters, numbers, and single hyphens",
  });

export const commandRuntimeSchema = z.object({
  adapter: z.literal("command"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

export const cloudConnectionSchema = z.object({
  id: identifier,
  name: z.string().min(1),
  provider: identifier,
  config: z.record(z.string(), z.unknown()),
});

const kubeconfigSourceSchema = z.object({
  type: z.literal("kubeconfig"),
  path: z.string().min(1),
  context: z.string().min(1),
});

const generatedKubernetesSourceSchema = z.object({
  type: z.literal("generated"),
  server: z.string().url(),
  context: z.string().min(1),
});

export const kubernetesContextSchema = z.object({
  id: identifier,
  name: z.string().min(1),
  namespace: z.string().min(1).optional(),
  source: z.discriminatedUnion("type", [
    kubeconfigSourceSchema,
    generatedKubernetesSourceSchema,
  ]),
});

export const directorySchema = z.object({
  id: identifier,
  name: z.string().min(1),
  path: z.string().min(1),
  access: z.enum(["read-only", "read-write"]),
});

const networkPolicySchema = z
  .object({
    mode: z.enum(["public", "deny", "allowlist"]),
    allowedDomains: z.array(z.string().min(1)).default([]),
  })
  .superRefine((policy, context) => {
    if (policy.mode === "allowlist" && policy.allowedDomains.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["allowedDomains"],
        message: "An allowlist network policy needs at least one domain",
      });
    }
  });

export const targetSchema = z.object({
  id: identifier,
  name: z.string().min(1),
  environment: z.string().min(1),
  risk: z.enum(["development", "staging", "production"]),
  cloudConnection: identifier.optional(),
  kubernetesContext: identifier.optional(),
  directories: z.array(identifier).min(1),
  defaultDirectory: identifier,
  agentRuntime: commandRuntimeSchema,
  isolation: z.object({
    mode: z.enum(["enforced", "context-only"]).default("enforced"),
    network: networkPolicySchema.default({
      mode: "public",
      allowedDomains: [],
    }),
  }),
});

export const workspaceManifestSchema = z.object({
  apiVersion: z.literal("opscapsule.dev/v1alpha1"),
  kind: z.literal("Workspace"),
  metadata: z.object({
    id: identifier,
    name: z.string().min(1),
    description: z.string().min(1).optional(),
  }),
  cloudConnections: z.array(cloudConnectionSchema).default([]),
  kubernetesContexts: z.array(kubernetesContextSchema).default([]),
  directories: z.array(directorySchema).min(1),
  targets: z.array(targetSchema).min(1),
});

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
export type CloudConnection = z.infer<typeof cloudConnectionSchema>;
export type KubernetesContext = z.infer<typeof kubernetesContextSchema>;
export type WorkspaceDirectory = z.infer<typeof directorySchema>;
export type WorkspaceTarget = z.infer<typeof targetSchema>;

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

export function validateWorkspaceReferences(
  manifest: WorkspaceManifest,
): void {
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

export function parseWorkspaceManifest(input: unknown): WorkspaceManifest {
  const manifest = workspaceManifestSchema.parse(input);
  validateWorkspaceReferences(manifest);
  return manifest;
}

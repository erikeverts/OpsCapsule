import { z } from "zod";
import { credentialReferenceSchema } from "./credentials.js";

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

const agentProcessSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

const safeHomeRelativePath = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const normalized = value.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "Use a normalized relative path without empty, '.' or '..' segments",
      });
    }
  });

const reservedAgentDestinations = [
  ".aws",
  ".kube",
  ".zshrc",
  ".bashrc",
  ".bash_profile",
  ".profile",
];

const reservedAgentEnvironmentVariables = new Set([
  "HOME",
  "PATH",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "USER",
  "LOGNAME",
  "TZ",
  "ZDOTDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CLAUDE_CODE_TMPDIR",
  "CLAUDE_CONFIG_DIR",
  "KUBECONFIG",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
]);

export const agentConfigurationFileSchema = z.object({
  source: z.string().min(1),
  destination: safeHomeRelativePath.superRefine((value, context) => {
    const normalized = value.replaceAll("\\", "/");
    if (
      reservedAgentDestinations.some(
        (reserved) => normalized === reserved || normalized.startsWith(`${reserved}/`),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "This destination is reserved by OpsCapsule",
      });
    }
  }),
});

export const agentProfileSchema = z
  .object({
    id: identifier,
    name: z.string().min(1),
    adapter: identifier,
    runtime: agentProcessSchema,
    configuration: z
      .object({ files: z.array(agentConfigurationFileSchema).default([]) })
      .default({ files: [] }),
    environment: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
          message: "Use a valid environment variable name",
        }),
        z.string(),
      )
      .default({}),
  })
  .superRefine((profile, context) => {
    for (const name of Object.keys(profile.environment)) {
      if (
        reservedAgentEnvironmentVariables.has(name) ||
        name.startsWith("LC_") ||
        name.startsWith("OPSCAPSULE_")
      ) {
        context.addIssue({
          code: "custom",
          path: ["environment", name],
          message: "This environment variable is managed by OpsCapsule",
        });
      }
    }
    const destinations = new Set<string>();
    for (const [index, file] of profile.configuration.files.entries()) {
      const destination = file.destination.replaceAll("\\", "/");
      if (destinations.has(destination)) {
        context.addIssue({
          code: "custom",
          path: ["configuration", "files", index, "destination"],
          message: `Duplicate configuration destination '${destination}'`,
        });
      }
      destinations.add(destination);
      if (
        profile.adapter === "opencode" &&
        ![
          ".config/opencode/opencode.json",
          ".config/opencode/tui.json",
        ].includes(destination)
      ) {
        context.addIssue({
          code: "custom",
          path: ["configuration", "files", index, "destination"],
          message: "OpenCode profiles support only opencode.json and tui.json settings",
        });
      }
      if (
        profile.adapter === "claude-code" &&
        destination !== ".claude/settings.json"
      ) {
        context.addIssue({
          code: "custom",
          path: ["configuration", "files", index, "destination"],
          message: "Claude Code profiles support only settings.json",
        });
      }
    }
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
  agentProfile: identifier.optional(),
  agentRuntime: commandRuntimeSchema.optional(),
  /** Brokered operational identity. Stays the capsule's default AWS profile. */
  operationalCredential: identifier.optional(),
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
  agentInstructions: z.string().max(50_000).optional(),
  agentProfiles: z.array(agentProfileSchema).default([]),
  defaultAgentProfile: identifier.optional(),
  /**
   * Credential *references*, never credential values. Safe to serialize and
   * safe to show the renderer; secret material lives only in the OS-backed
   * credential store.
   */
  credentials: z.array(credentialReferenceSchema).default([]),
  /**
   * The inference identity, used only by the model provider. Normally
   * user-scoped so one central Bedrock account is reused everywhere, while
   * operational identities stay target-scoped.
   */
  inferenceCredential: identifier.optional(),
  cloudConnections: z.array(cloudConnectionSchema).default([]),
  kubernetesContexts: z.array(kubernetesContextSchema).default([]),
  directories: z.array(directorySchema).min(1),
  targets: z.array(targetSchema).min(1),
});

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
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
  assertUniqueIds(manifest.agentProfiles, "agent profile");
  assertUniqueIds(manifest.credentials, "credential reference");

  const cloudIds = new Set(manifest.cloudConnections.map(({ id }) => id));
  const kubernetesIds = new Set(
    manifest.kubernetesContexts.map(({ id }) => id),
  );
  const directoryIds = new Set(manifest.directories.map(({ id }) => id));
  const agentProfileIds = new Set(manifest.agentProfiles.map(({ id }) => id));
  const credentialIds = new Set(manifest.credentials.map(({ id }) => id));

  if (
    manifest.inferenceCredential &&
    !credentialIds.has(manifest.inferenceCredential)
  ) {
    throw new Error(
      `Workspace references unknown inference credential '${manifest.inferenceCredential}'`,
    );
  }

  if (
    manifest.defaultAgentProfile &&
    !agentProfileIds.has(manifest.defaultAgentProfile)
  ) {
    throw new Error(
      `Workspace references unknown default agent profile '${manifest.defaultAgentProfile}'`,
    );
  }

  for (const target of manifest.targets) {
    if (target.agentProfile && !agentProfileIds.has(target.agentProfile)) {
      throw new Error(
        `Target '${target.id}' references unknown agent profile '${target.agentProfile}'`,
      );
    }
    if (
      !target.agentProfile &&
      !manifest.defaultAgentProfile &&
      !target.agentRuntime
    ) {
      throw new Error(
        `Target '${target.id}' needs an agent profile, a workspace default, or a legacy agent runtime`,
      );
    }
    if (
      target.operationalCredential &&
      !credentialIds.has(target.operationalCredential)
    ) {
      throw new Error(
        `Target '${target.id}' references unknown operational credential '${target.operationalCredential}'`,
      );
    }
    if (
      target.operationalCredential &&
      target.operationalCredential === manifest.inferenceCredential
    ) {
      throw new Error(
        `Target '${target.id}' must not reuse the inference credential as its operational identity`,
      );
    }
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

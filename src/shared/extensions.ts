import { z } from "zod";

export const EXTENSION_MANIFEST_API_VERSION = "opscapsule.dev/v1alpha1";
export const EXTENSION_HOST_API_VERSION =
  "opscapsule.dev/extension-host/v1alpha1";

const MAX_CONTRIBUTIONS = 32;
const MAX_PERMISSION_ENTRIES = 32;

const localIdentifierSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Use lowercase letters, numbers, and single hyphens",
  });

export const extensionIdentifierSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/,
    {
      message:
        "Use a stable lowercase identifier such as 'dev.opscapsule.colima'",
    },
  );

const semanticVersionSchema = z
  .string()
  .max(80)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    { message: "Use an exact semantic version" },
  );

const bundleRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .superRefine((value, context) => {
    const segments = value.split("/");
    if (
      value.includes("\\") ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Use a normalized path inside the extension bundle without '.', '..', or absolute segments",
      });
    }
  });

function validPort(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  const port = Number(value);
  return port >= 1 && port <= 65_535;
}

const domainPatternSchema = z
  .string()
  .min(1)
  .max(300)
  .superRefine((value, context) => {
    if (/^\[[0-9A-Fa-f:]+\](?::\d+)?$/.test(value)) {
      const port = value.match(/\]:(\d+)$/)?.[1];
      if (port && !validPort(port)) {
        context.addIssue({ code: "custom", message: "Invalid network port" });
      }
      return;
    }

    const match = value.match(/^(.*?)(?::(\d+))?$/);
    const host = match?.[1] ?? "";
    const port = match?.[2];
    if (port && !validPort(port)) {
      context.addIssue({ code: "custom", message: "Invalid network port" });
      return;
    }

    const wildcard = host.startsWith("*.");
    const domain = wildcard ? host.slice(2) : host;
    const labels = domain.split(".");
    if (
      host === "*" ||
      (wildcard && labels.length < 2) ||
      labels.some(
        (label) =>
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Use a domain, a narrow wildcard domain, or a bracketed IPv6 literal",
      });
    }
  });

export const extensionScopeSchema = z.enum([
  "application",
  "workspace",
  "target",
]);

export const extensionPlatformSchema = z.enum([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);

const extensionContractSchema = z
  .string()
  .min(1)
  .max(180)
  .regex(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+\/v\d+(?:(?:alpha|beta)\d+)?$/,
    {
      message:
        "Use a versioned contract such as 'opscapsule.dev/container-runtime/v1alpha1'",
    },
  );

const settingsContributionSchema = z
  .object({
    id: localIdentifierSchema,
    label: z.string().min(1).max(100),
    scope: extensionScopeSchema,
    schema: bundleRelativePathSchema,
  })
  .strict();

const readinessContributionSchema = z
  .object({
    id: localIdentifierSchema,
    label: z.string().min(1).max(100),
    scope: extensionScopeSchema,
  })
  .strict();

const actionContributionSchema = z
  .object({
    id: localIdentifierSchema,
    label: z.string().min(1).max(100),
    scope: extensionScopeSchema,
    risk: z.enum(["read", "write", "destructive"]),
  })
  .strict();

const sourceContributionSchema = z
  .object({
    id: localIdentifierSchema,
    label: z.string().min(1).max(100),
    scope: z.enum(["workspace", "target"]),
  })
  .strict();

const targetServiceContributionSchema = z
  .object({
    id: localIdentifierSchema,
    label: z.string().min(1).max(100),
    scope: z.literal("target"),
    contract: extensionContractSchema,
  })
  .strict();

const commandPermissionSchema = z
  .object({
    id: localIdentifierSchema,
    label: z.string().min(1).max(100),
    command: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, {
        message: "Declare a command name, not a path or shell expression",
      }),
    scope: extensionScopeSchema,
  })
  .strict();

const networkPermissionSchema = z
  .object({
    id: localIdentifierSchema,
    label: z.string().min(1).max(100),
    scope: extensionScopeSchema,
    mode: z.enum(["deny", "allowlist", "public"]),
    allowedDomains: z.array(domainPatternSchema).max(100).default([]),
  })
  .strict()
  .superRefine((permission, context) => {
    if (
      permission.mode === "allowlist" &&
      permission.allowedDomains.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedDomains"],
        message: "An allowlist permission needs at least one domain",
      });
    }
    if (
      permission.mode !== "allowlist" &&
      permission.allowedDomains.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedDomains"],
        message: "Only allowlist permissions may declare domains",
      });
    }
  });

const targetDirectoryPermissionSchema = z
  .object({
    id: localIdentifierSchema,
    label: z.string().min(1).max(100),
    scope: z.literal("target"),
    access: z.enum(["read-only", "declared"]),
  })
  .strict();

const credentialPermissionSchema = z
  .object({
    id: localIdentifierSchema,
    label: z.string().min(1).max(100),
    scope: extensionScopeSchema,
    kinds: z.array(localIdentifierSchema).min(1).max(20),
    delivery: z.enum(["brokered-pull", "brokered-materialize"]),
  })
  .strict();

const socketPermissionSchema = z
  .object({
    id: localIdentifierSchema,
    label: z.string().min(1).max(100),
    scope: z.literal("target"),
  })
  .strict();

const environmentPermissionSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
        message: "Use a valid environment variable name",
      }),
    scope: z.literal("target"),
  })
  .strict();

export const extensionPermissionsSchema = z
  .object({
    host: z
      .object({
        privateState: z
          .array(extensionScopeSchema)
          .max(3)
          .default([]),
        commands: z
          .array(commandPermissionSchema)
          .max(MAX_PERMISSION_ENTRIES)
          .default([]),
        network: z
          .array(networkPermissionSchema)
          .max(MAX_PERMISSION_ENTRIES)
          .default([]),
        targetDirectories: z
          .array(targetDirectoryPermissionSchema)
          .max(MAX_PERMISSION_ENTRIES)
          .default([]),
        credentials: z
          .array(credentialPermissionSchema)
          .max(MAX_PERMISSION_ENTRIES)
          .default([]),
      })
      .strict()
      .default({
        privateState: [],
        commands: [],
        network: [],
        targetDirectories: [],
        credentials: [],
      }),
    capsule: z
      .object({
        sockets: z
          .array(socketPermissionSchema)
          .max(MAX_PERMISSION_ENTRIES)
          .default([]),
        environment: z
          .array(environmentPermissionSchema)
          .max(MAX_PERMISSION_ENTRIES)
          .default([]),
      })
      .strict()
      .default({ sockets: [], environment: [] }),
  })
  .strict()
  .default({
    host: {
      privateState: [],
      commands: [],
      network: [],
      targetDirectories: [],
      credentials: [],
    },
    capsule: { sockets: [], environment: [] },
  });

const extensionContributionsSchema = z
  .object({
    settings: z
      .array(settingsContributionSchema)
      .max(MAX_CONTRIBUTIONS)
      .default([]),
    readinessChecks: z
      .array(readinessContributionSchema)
      .max(MAX_CONTRIBUTIONS)
      .default([]),
    actions: z
      .array(actionContributionSchema)
      .max(MAX_CONTRIBUTIONS)
      .default([]),
    taskSources: z
      .array(sourceContributionSchema)
      .max(MAX_CONTRIBUTIONS)
      .default([]),
    contextSources: z
      .array(sourceContributionSchema)
      .max(MAX_CONTRIBUTIONS)
      .default([]),
    targetServices: z
      .array(targetServiceContributionSchema)
      .max(MAX_CONTRIBUTIONS)
      .default([]),
  })
  .strict()
  .default({
    settings: [],
    readinessChecks: [],
    actions: [],
    taskSources: [],
    contextSources: [],
    targetServices: [],
  });

const extensionMetadataSchema = z
  .object({
    id: extensionIdentifierSchema,
    name: z.string().min(1).max(100),
    version: semanticVersionSchema,
    publisher: z.string().min(1).max(100),
    description: z.string().min(1).max(500).optional(),
    homepage: z
      .string()
      .url()
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
        message: "Use an HTTP or HTTPS homepage URL",
      })
      .optional(),
  })
  .strict();

function reportDuplicateIds(
  groups: readonly {
    values: readonly { id: string }[];
    path: (string | number)[];
  }[],
  kind: "contribution" | "permission",
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const [index, value] of group.values.entries()) {
      if (seen.has(value.id)) {
        context.addIssue({
          code: "custom",
          path: [...group.path, index, "id"],
          message: `Duplicate ${kind} id '${value.id}'`,
        });
      }
      seen.add(value.id);
    }
  }
}

export const extensionManifestSchema = z
  .object({
    apiVersion: z.literal(EXTENSION_MANIFEST_API_VERSION),
    kind: z.literal("Extension"),
    metadata: extensionMetadataSchema,
    compatibility: z
      .object({
        hostApi: z.literal(EXTENSION_HOST_API_VERSION),
        opscapsule: z.string().min(1).max(120),
        platforms: z.array(extensionPlatformSchema).min(1).max(6),
      })
      .strict(),
    execution: z
      .object({ mode: z.literal("built-in") })
      .strict()
      .default({ mode: "built-in" }),
    contributes: extensionContributionsSchema,
    permissions: extensionPermissionsSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const platforms = new Set<string>();
    for (const [index, platform] of manifest.compatibility.platforms.entries()) {
      if (platforms.has(platform)) {
        context.addIssue({
          code: "custom",
          path: ["compatibility", "platforms", index],
          message: `Duplicate platform '${platform}'`,
        });
      }
      platforms.add(platform);
    }

    reportDuplicateIds(
      [
        {
          values: manifest.contributes.settings,
          path: ["contributes", "settings"],
        },
        {
          values: manifest.contributes.readinessChecks,
          path: ["contributes", "readinessChecks"],
        },
        {
          values: manifest.contributes.actions,
          path: ["contributes", "actions"],
        },
        {
          values: manifest.contributes.taskSources,
          path: ["contributes", "taskSources"],
        },
        {
          values: manifest.contributes.contextSources,
          path: ["contributes", "contextSources"],
        },
        {
          values: manifest.contributes.targetServices,
          path: ["contributes", "targetServices"],
        },
      ],
      "contribution",
      context,
    );
    reportDuplicateIds(
      [
        {
          values: manifest.permissions.host.commands,
          path: ["permissions", "host", "commands"],
        },
        {
          values: manifest.permissions.host.network,
          path: ["permissions", "host", "network"],
        },
        {
          values: manifest.permissions.host.targetDirectories,
          path: ["permissions", "host", "targetDirectories"],
        },
        {
          values: manifest.permissions.host.credentials,
          path: ["permissions", "host", "credentials"],
        },
        {
          values: manifest.permissions.capsule.sockets,
          path: ["permissions", "capsule", "sockets"],
        },
      ],
      "permission",
      context,
    );

    const environmentNames = new Set<string>();
    for (const [index, entry] of manifest.permissions.capsule.environment.entries()) {
      if (environmentNames.has(entry.name)) {
        context.addIssue({
          code: "custom",
          path: ["permissions", "capsule", "environment", index, "name"],
          message: `Duplicate environment permission '${entry.name}'`,
        });
      }
      environmentNames.add(entry.name);
    }
  });

export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;
export type ExtensionPermissions = z.infer<typeof extensionPermissionsSchema>;
export type ExtensionScope = z.infer<typeof extensionScopeSchema>;

export function parseExtensionManifest(input: unknown): ExtensionManifest {
  return extensionManifestSchema.parse(input);
}

export const extensionActivationScopeSchema = z.discriminatedUnion("level", [
  z.object({ level: z.literal("application") }).strict(),
  z
    .object({
      level: z.literal("workspace"),
      workspaceId: localIdentifierSchema,
    })
    .strict(),
  z
    .object({
      level: z.literal("target"),
      workspaceId: localIdentifierSchema,
      targetId: localIdentifierSchema,
    })
    .strict(),
  z
    .object({
      level: z.literal("capsule"),
      workspaceId: localIdentifierSchema,
      targetId: localIdentifierSchema,
      sessionId: z.string().min(1).max(160),
    })
    .strict(),
]);

export const extensionLifecyclePhaseSchema = z.enum([
  "installed",
  "disabled",
  "enabled",
  "activating",
  "active",
  "deactivating",
  "failed",
]);

export const extensionHostContextSchema = z
  .object({
    apiVersion: z.literal(EXTENSION_HOST_API_VERSION),
    extension: z
      .object({
        id: extensionIdentifierSchema,
        version: semanticVersionSchema,
        manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/, {
          message: "Bind grants to a lowercase SHA-256 manifest digest",
        }),
      })
      .strict(),
    activation: extensionActivationScopeSchema,
    grantedPermissions: extensionPermissionsSchema,
  })
  .strict();

export const extensionReadinessResultSchema = z
  .object({
    contributionId: localIdentifierSchema,
    status: z.enum(["pass", "warning", "fail"]),
    detail: z.string().min(1).max(500),
    details: z.array(z.string().min(1).max(500)).max(50).default([]),
  })
  .strict();

export type ExtensionActivationScope = z.infer<
  typeof extensionActivationScopeSchema
>;
export type ExtensionLifecyclePhase = z.infer<
  typeof extensionLifecyclePhaseSchema
>;
export type ExtensionHostContext = z.infer<typeof extensionHostContextSchema>;
export type ExtensionReadinessResult = z.infer<
  typeof extensionReadinessResultSchema
>;

/**
 * The complete callable host API for slice 1. It is deliberately small: no
 * filesystem, process, network, socket, or credential primitive is exposed.
 * Later brokers must be explicit additions to a versioned interface rather
 * than generic escape hatches.
 */
export interface ExtensionHostApiV1Alpha1 {
  readonly context: ExtensionHostContext;
  readSettings(contributionId: string): Promise<unknown>;
  reportReadiness(result: ExtensionReadinessResult): Promise<void>;
}

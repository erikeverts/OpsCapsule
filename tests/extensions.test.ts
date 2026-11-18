import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  EXTENSION_HOST_API_VERSION,
  extensionActivationScopeSchema,
  extensionHostContextSchema,
  parseExtensionManifest,
} from "../src/shared/extensions.js";

function manifest(): Record<string, unknown> {
  return {
    apiVersion: "opscapsule.dev/v1alpha1",
    kind: "Extension",
    metadata: {
      id: "dev.opscapsule.colima",
      name: "Isolated Docker runtime",
      version: "1.0.0",
      publisher: "OpsCapsule",
    },
    compatibility: {
      hostApi: EXTENSION_HOST_API_VERSION,
      opscapsule: ">=0.5.0 <1.0.0",
      platforms: ["darwin-arm64", "darwin-x64"],
    },
    execution: { mode: "built-in" },
    contributes: {
      settings: [],
      readinessChecks: [
        { id: "colima-installed", label: "Colima installed", scope: "target" },
      ],
      actions: [
        {
          id: "reset-runtime",
          label: "Reset Docker environment",
          scope: "target",
          risk: "destructive",
        },
      ],
      taskSources: [],
      contextSources: [],
      targetServices: [
        {
          id: "docker-runtime",
          label: "Docker runtime",
          scope: "target",
          contract: "opscapsule.dev/container-runtime/v1alpha1",
        },
      ],
    },
    permissions: {
      host: {
        privateState: ["target"],
        commands: [
          {
            id: "colima",
            label: "Colima",
            command: "colima",
            scope: "target",
          },
        ],
        network: [
          {
            id: "runtime-egress",
            label: "Container runtime network",
            scope: "target",
            mode: "public",
            allowedDomains: [],
          },
        ],
        targetDirectories: [
          {
            id: "target-mounts",
            label: "Configured target directories",
            scope: "target",
            access: "declared",
          },
        ],
        credentials: [],
      },
      capsule: {
        sockets: [
          {
            id: "docker-socket",
            label: "Target Docker socket",
            scope: "target",
          },
        ],
        environment: [
          { name: "DOCKER_HOST", scope: "target" },
          { name: "DOCKER_CONFIG", scope: "target" },
        ],
      },
    },
  };
}

describe("extension manifest contract", () => {
  it("keeps the documented Colima-shaped example valid", async () => {
    const yaml = await readFile(
      new URL("../examples/extensions/colima/extension.yaml", import.meta.url),
      "utf8",
    );

    expect(parseExtensionManifest(parse(yaml)).metadata.id).toBe(
      "dev.opscapsule.colima",
    );
  });

  it("accepts a built-in extension with declared contributions and permissions", () => {
    const parsed = parseExtensionManifest(manifest());

    expect(parsed.metadata.id).toBe("dev.opscapsule.colima");
    expect(parsed.execution.mode).toBe("built-in");
    expect(parsed.permissions.host.commands[0]?.command).toBe("colima");
    expect(parsed.contributes.targetServices[0]?.contract).toBe(
      "opscapsule.dev/container-runtime/v1alpha1",
    );
  });

  it("defaults omitted contribution and permission collections to empty", () => {
    const input = manifest();
    delete input.execution;
    delete input.contributes;
    delete input.permissions;

    const parsed = parseExtensionManifest(input);

    expect(parsed.execution).toEqual({ mode: "built-in" });
    expect(parsed.contributes.actions).toEqual([]);
    expect(parsed.permissions.host.commands).toEqual([]);
    expect(parsed.permissions.capsule.sockets).toEqual([]);
  });

  it("does not allow a manifest to load arbitrary executable code", () => {
    const input = manifest();
    input.execution = {
      mode: "process",
      entrypoint: "dist/extension.js",
    };

    expect(() => parseExtensionManifest(input)).toThrow();
  });

  it("rejects unknown permission categories instead of silently ignoring them", () => {
    const input = manifest();
    const permissions = input.permissions as {
      host: Record<string, unknown>;
    };
    permissions.host.filesystem = [{ path: "/", access: "read-write" }];

    expect(() => parseExtensionManifest(input)).toThrow(/Unrecognized key/);
  });

  it("does not allow settings schemas to escape an extension bundle", () => {
    const input = manifest();
    const contributes = input.contributes as {
      settings: Array<Record<string, unknown>>;
    };
    contributes.settings.push({
      id: "settings",
      label: "Settings",
      scope: "workspace",
      schema: "../outside.json",
    });

    expect(() => parseExtensionManifest(input)).toThrow(/inside the extension bundle/);
  });

  it("rejects duplicate ids across contribution categories", () => {
    const input = manifest();
    const contributes = input.contributes as {
      actions: Array<Record<string, unknown>>;
    };
    contributes.actions.push({
      id: "colima-installed",
      label: "Duplicate",
      scope: "target",
      risk: "read",
    });

    expect(() => parseExtensionManifest(input)).toThrow(
      /Duplicate contribution id 'colima-installed'/,
    );
  });

  it("rejects duplicate ids across host and capsule permissions", () => {
    const input = manifest();
    const permissions = input.permissions as {
      capsule: { sockets: Array<Record<string, unknown>> };
    };
    permissions.capsule.sockets[0]!.id = "colima";

    expect(() => parseExtensionManifest(input)).toThrow(
      /Duplicate permission id 'colima'/,
    );
  });

  it("allows a narrow network wildcard and rejects an overly broad one", () => {
    const input = manifest();
    const permissions = input.permissions as {
      host: { network: Array<Record<string, unknown>> };
    };
    permissions.host.network[0] = {
      id: "github",
      label: "GitHub API",
      scope: "workspace",
      mode: "allowlist",
      allowedDomains: ["*.github.com:443"],
    };
    expect(parseExtensionManifest(input).permissions.host.network[0]?.mode).toBe(
      "allowlist",
    );

    permissions.host.network[0]!.allowedDomains = ["*.com"];
    expect(() => parseExtensionManifest(input)).toThrow(/narrow wildcard/);
  });

  it("declares executable names rather than host paths or shell expressions", () => {
    const input = manifest();
    const permissions = input.permissions as {
      host: { commands: Array<Record<string, unknown>> };
    };
    permissions.host.commands[0]!.command = "/opt/homebrew/bin/colima";

    expect(() => parseExtensionManifest(input)).toThrow(
      /command name, not a path or shell expression/,
    );
  });

  it("rejects raw credential values in a broker permission", () => {
    const input = manifest();
    const permissions = input.permissions as {
      host: { credentials: Array<Record<string, unknown>> };
    };
    permissions.host.credentials.push({
      id: "github-login",
      label: "GitHub login",
      scope: "workspace",
      kinds: ["provider-oauth"],
      delivery: "brokered-pull",
      token: "must-not-be-here",
    });

    expect(() => parseExtensionManifest(input)).toThrow(/Unrecognized key/);
  });

  it("allows only web homepage links in untrusted metadata", () => {
    const input = manifest();
    const metadata = input.metadata as Record<string, unknown>;
    metadata.homepage = "javascript:alert(document.domain)";

    expect(() => parseExtensionManifest(input)).toThrow(
      /HTTP or HTTPS homepage URL/,
    );
  });
});

describe("extension host boundary", () => {
  it("requires complete target and capsule activation identities", () => {
    expect(
      extensionActivationScopeSchema.parse({
        level: "target",
        workspaceId: "atlas",
        targetId: "production",
      }),
    ).toEqual({
      level: "target",
      workspaceId: "atlas",
      targetId: "production",
    });
    expect(() =>
      extensionActivationScopeSchema.parse({
        level: "target",
        targetId: "production",
      }),
    ).toThrow();
  });

  it("binds a host context to an exact extension version and manifest digest", () => {
    const parsed = extensionHostContextSchema.parse({
      apiVersion: EXTENSION_HOST_API_VERSION,
      extension: {
        id: "dev.opscapsule.colima",
        version: "1.0.0",
        manifestDigest: `sha256:${"a".repeat(64)}`,
      },
      activation: {
        level: "capsule",
        workspaceId: "atlas",
        targetId: "production",
        sessionId: "session-1",
      },
      grantedPermissions: parseExtensionManifest(manifest()).permissions,
    });

    expect(parsed.extension.manifestDigest).toHaveLength(71);
    expect(parsed.activation.level).toBe("capsule");
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { CloudAdapterRegistry } from "../src/main/cloud-adapters/registry.js";
import {
  buildWorkspaceEnvironment,
  cleanupWorkspaceRuntime,
  createWorkspaceRuntime,
} from "../src/main/runtime-directory.js";
import { WorkspaceRegistry } from "../src/main/workspace-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("workspace runtime isolation", () => {
  it("imports managed agent configuration and keeps state target-specific", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "opscapsule-agent-"));
    temporaryDirectories.push(baseDirectory);
    const sourceConfig = join(baseDirectory, "opencode.json");
    await writeFile(sourceConfig, '{"provider":"example"}\n');
    const registry = new WorkspaceRegistry(baseDirectory);
    await registry.initialize();
    const source = await registry.document("atlas");
    const manifest = structuredClone(source.manifest);
    manifest.metadata = { id: "managed-agent", name: "Managed Agent" };
    manifest.agentInstructions = "# Operations\n\nVerify context before changes.\n";
    manifest.targets = manifest.targets.slice(0, 1);
    manifest.agentProfiles = [
      {
        id: "opencode",
        name: "OpenCode",
        adapter: "opencode",
        runtime: { command: "opencode", args: [] },
        configuration: {
          files: [
            {
              source: sourceConfig,
              destination: ".config/opencode/opencode.json",
            },
          ],
        },
        environment: {},
      },
    ];
    manifest.defaultAgentProfile = "opencode";
    delete manifest.targets[0]!.agentProfile;
    delete manifest.targets[0]!.agentRuntime;

    const created = await registry.create(manifest);
    expect(
      created.manifest.agentProfiles[0]?.configuration.files[0]?.source,
    ).toBe("resources/agents/opencode/opencode.json");

    const target = await registry.resolveTarget("managed-agent", "development");
    const runtime = await createWorkspaceRuntime(
      baseDirectory,
      "agent-session",
      target,
    );
    const stagedConfig = join(
      runtime.home,
      ".config",
      "opencode",
      "opencode.json",
    );
    expect(await readFile(stagedConfig, "utf8")).toContain(
      '"provider":"example"',
    );
    expect(await readFile(runtime.agentInstructions!, "utf8")).toContain(
      "Verify context",
    );
    expect(
      await readFile(join(runtime.home, ".config", "opencode", "AGENTS.md"), "utf8"),
    ).toContain("Verify context");
    expect(
      buildWorkspaceEnvironment(runtime, target).OPSCAPSULE_AGENT_INSTRUCTIONS,
    ).toBe(runtime.agentInstructions);
    expect(runtime.agentState).toBe(
      join(
        runtime.targetState,
        "agents",
        "opencode",
      ),
    );
    const sessionMarker = join(runtime.agentState, "sessions", "marker");
    await writeFile(sessionMarker, "persistent\n");

    await cleanupWorkspaceRuntime(runtime);
    expect(await readFile(sessionMarker, "utf8")).toBe("persistent\n");
  });

  it("materializes portable instructions into isolated Claude Code state", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "opscapsule-claude-"));
    temporaryDirectories.push(baseDirectory);
    const sourceConfig = join(baseDirectory, "settings.json");
    await writeFile(sourceConfig, '{"model":"sonnet"}\n');
    const registry = new WorkspaceRegistry(baseDirectory);
    await registry.initialize();
    const source = await registry.document("atlas");
    const manifest = structuredClone(source.manifest);
    manifest.metadata = { id: "claude-agent", name: "Claude Agent" };
    manifest.targets = manifest.targets.slice(0, 1);
    manifest.agentInstructions = "# Workspace\n\nUse read-only checks first.\n";
    manifest.agentProfiles = [
      {
        id: "claude",
        name: "Claude Code",
        adapter: "claude-code",
        runtime: { command: "claude", args: [] },
        configuration: {
          files: [
            {
              source: sourceConfig,
              destination: ".claude/settings.json",
            },
          ],
        },
        environment: {},
      },
    ];
    manifest.defaultAgentProfile = "claude";
    delete manifest.targets[0]!.agentProfile;
    delete manifest.targets[0]!.agentRuntime;
    await registry.create(manifest);

    const target = await registry.resolveTarget("claude-agent", "development");
    const runtime = await createWorkspaceRuntime(
      baseDirectory,
      "claude-session",
      target,
    );

    expect(
      await readFile(join(runtime.home, ".claude", "settings.json"), "utf8"),
    ).toContain("sonnet");
    expect(
      await readFile(
        join(runtime.agentState, "data", "claude", "CLAUDE.md"),
        "utf8",
      ),
    ).toContain("Use read-only checks first");

    await cleanupWorkspaceRuntime(runtime);
  });

  it("creates separate runtime homes, temp directories, and kubeconfigs", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "opscapsule-runtime-"));
    temporaryDirectories.push(baseDirectory);
    const registry = new WorkspaceRegistry(baseDirectory);
    await registry.initialize();
    const development = await registry.resolveTarget("atlas", "development");
    const production = await registry.resolveTarget("atlas", "production");
    const developmentRuntime = await createWorkspaceRuntime(
      baseDirectory,
      "development-session",
      development,
    );
    const productionRuntime = await createWorkspaceRuntime(
      baseDirectory,
      "production-session",
      production,
    );
    const cloudAdapters = new CloudAdapterRegistry();
    const developmentEnvironment = buildWorkspaceEnvironment(
      developmentRuntime,
      development,
      cloudAdapters,
      {
        PATH: "/test/bin",
        AWS_ACCESS_KEY_ID: "must-not-leak",
        UNRELATED_API_TOKEN: "must-not-leak",
      },
    );
    const productionEnvironment = buildWorkspaceEnvironment(
      productionRuntime,
      production,
      cloudAdapters,
      { PATH: "/test/bin", AWS_PROFILE: "wrong-profile" },
    );

    expect(developmentRuntime.home).not.toBe(productionRuntime.home);
    expect(developmentRuntime.temp).not.toBe(productionRuntime.temp);
    expect(developmentEnvironment.HOME).toBe(developmentRuntime.home);
    expect(developmentEnvironment.TMPDIR).toBe(developmentRuntime.temp);
    expect(developmentEnvironment.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(developmentEnvironment.UNRELATED_API_TOKEN).toBeUndefined();
    expect(developmentEnvironment.AWS_PROFILE).toBe("atlas-nonprod");
    expect(productionEnvironment.AWS_PROFILE).toBe("atlas-prod");

    const developmentConfig = await readFile(
      developmentRuntime.kubeconfig,
      "utf8",
    );
    const productionConfig = await readFile(
      productionRuntime.kubeconfig,
      "utf8",
    );
    expect(developmentConfig).toContain("current-context: atlas-development");
    expect(productionConfig).toContain("current-context: atlas-production");

    await writeFile(developmentRuntime.kubeconfig, "current-context: changed\n");
    expect(await readFile(productionRuntime.kubeconfig, "utf8")).toBe(
      productionConfig,
    );

    await Promise.all([
      cleanupWorkspaceRuntime(developmentRuntime),
      cleanupWorkspaceRuntime(productionRuntime),
    ]);
  });

  it("extracts only the Kubernetes context selected by a target", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "opscapsule-kube-"));
    temporaryDirectories.push(baseDirectory);
    const configDirectory = join(baseDirectory, "config", "workspaces");
    const projectDirectory = join(baseDirectory, "project");
    const sourceKubeconfig = join(baseDirectory, "source-kubeconfig.yaml");
    await Promise.all([
      mkdir(configDirectory, { recursive: true }),
      mkdir(projectDirectory, { recursive: true }),
    ]);
    await writeFile(
      sourceKubeconfig,
      stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          { name: "dev-cluster", cluster: { server: "https://dev.invalid" } },
          {
            name: "prod-cluster",
            cluster: { server: "https://prod.invalid" },
          },
        ],
        contexts: [
          {
            name: "development",
            context: { cluster: "dev-cluster", user: "dev-user" },
          },
          {
            name: "production",
            context: { cluster: "prod-cluster", user: "prod-user" },
          },
        ],
        users: [
          { name: "dev-user", user: { token: "dev-token" } },
          { name: "prod-user", user: { token: "prod-token" } },
        ],
      }),
    );
    await writeFile(
      join(configDirectory, "custom.yaml"),
      stringify({
        apiVersion: "opscapsule.dev/v1alpha1",
        kind: "Workspace",
        metadata: { id: "custom", name: "Custom" },
        cloudConnections: [],
        kubernetesContexts: [
          {
            id: "production",
            name: "Production",
            namespace: "platform",
            source: {
              type: "kubeconfig",
              path: sourceKubeconfig,
              context: "production",
            },
          },
        ],
        directories: [
          {
            id: "project",
            name: "Project",
            path: projectDirectory,
            access: "read-write",
          },
        ],
        targets: [
          {
            id: "production",
            name: "Production",
            environment: "production",
            risk: "production",
            kubernetesContext: "production",
            directories: ["project"],
            defaultDirectory: "project",
            agentRuntime: { adapter: "command", command: "$SHELL", args: [] },
            isolation: {
              mode: "context-only",
              network: { mode: "deny", allowedDomains: [] },
            },
          },
        ],
      }),
    );
    const registry = new WorkspaceRegistry(baseDirectory);
    await registry.initialize();
    const target = await registry.resolveTarget("custom", "production");
    expect(target.summary.agent.legacy).toBe(true);
    const runtime = await createWorkspaceRuntime(
      baseDirectory,
      "custom-session",
      target,
    );

    const extracted = await readFile(runtime.kubeconfig, "utf8");
    expect(extracted).toContain("current-context: production");
    expect(extracted).toContain("https://prod.invalid");
    expect(extracted).toContain("prod-token");
    expect(extracted).not.toContain("https://dev.invalid");
    expect(extracted).not.toContain("dev-token");

    await cleanupWorkspaceRuntime(runtime);
  });

  it("stages imported AWS configuration into persistent target state", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "opscapsule-aws-"));
    temporaryDirectories.push(baseDirectory);
    const sourceConfig = join(baseDirectory, "aws-config");
    await writeFile(
      sourceConfig,
      [
        "[profile development]",
        "sso_session = example",
        "sso_account_id = 111122223333",
        "region = eu-west-1",
        "",
        "[sso-session example]",
        "sso_start_url = https://example.awsapps.com/start",
        "sso_region = eu-west-1",
        "",
      ].join("\n"),
    );
    const registry = new WorkspaceRegistry(baseDirectory);
    await registry.initialize();
    const source = await registry.document("atlas");
    const manifest = structuredClone(source.manifest);
    manifest.metadata = { id: "imported", name: "Imported" };
    manifest.cloudConnections = manifest.cloudConnections.slice(0, 1);
    manifest.kubernetesContexts = manifest.kubernetesContexts.slice(0, 1);
    manifest.targets = manifest.targets.slice(0, 1);
    const authentication = manifest.cloudConnections[0]!.config.authentication as {
      type: "profile";
      profile: string;
      configFile?: string;
    };
    authentication.profile = "development";
    authentication.configFile = sourceConfig;
    await registry.create(manifest);

    const target = await registry.resolveTarget("imported", "development");
    const runtime = await createWorkspaceRuntime(
      baseDirectory,
      "aws-session",
      target,
    );
    const environment = buildWorkspaceEnvironment(runtime, target);
    const stagedConfig = join(runtime.targetState, ".aws", "config");

    expect(environment.AWS_CONFIG_FILE).toBe(stagedConfig);
    expect(environment.AWS_SHARED_CREDENTIALS_FILE).toBe(
      join(runtime.targetState, ".aws", "credentials"),
    );
    expect(await readFile(stagedConfig, "utf8")).toContain(
      "[profile development]",
    );
    await cleanupWorkspaceRuntime(runtime);
    expect(await readFile(stagedConfig, "utf8")).toContain(
      "[sso-session example]",
    );
  });
});

describe("brokered credentials in the launch path", () => {
  async function prepare(options: {
    withCredentials: boolean;
    kind?: "aws-profile" | "provider-oauth";
  }) {
    const baseDirectory = await mkdtemp(join(tmpdir(), "opscapsule-broker-"));
    temporaryDirectories.push(baseDirectory);
    const registry = new WorkspaceRegistry(baseDirectory);
    await registry.initialize();
    const source = await registry.document("atlas");
    const manifest = structuredClone(source.manifest);
    manifest.metadata = { id: "brokered", name: "Brokered" };
    manifest.targets = manifest.targets.slice(0, 1);

    if (options.withCredentials) {
      const kind = options.kind ?? "aws-profile";
      if (kind === "provider-oauth") {
        manifest.credentials = [
          {
            id: "central-inference",
            name: "GitHub Copilot",
            kind: "provider-oauth",
            scope: "user",
            providerId: "opencode",
          },
        ];
        manifest.inferenceCredential = "central-inference";
      } else {
        manifest.credentials = [
          {
            id: "target-operational",
            name: "Customer production",
            kind: "aws-profile",
            scope: "target",
            region: "eu-west-1",
          },
          {
            id: "central-inference",
            name: "Central Bedrock",
            kind: "aws-profile",
            scope: "user",
            region: "us-east-1",
          },
        ];
        manifest.inferenceCredential = "central-inference";
        manifest.targets[0]!.operationalCredential = "target-operational";
      }
    }

    const created = await registry.create(manifest);
    const resolved = await registry.resolveTarget(
      created.manifest.metadata.id,
      created.manifest.targets[0]!.id,
    );
    const runtime = await createWorkspaceRuntime(
      baseDirectory,
      "00000000-aaaa-bbbb-cccc-000000000001",
      resolved,
      async () => JSON.stringify({ github: { type: "oauth", access: "tok" } }),
    );
    return { runtime, resolved };
  }

  it("gives a capsule no broker channel when its credentials are materialized", async () => {
    // A Copilot-backed capsule reads a file; nothing pulls, so it must not be
    // granted a unix socket into the main process.
    const { runtime } = await prepare({
      withCredentials: true,
      kind: "provider-oauth",
    });
    expect(runtime.brokerSocket).toBeUndefined();
    expect(runtime.brokerHelper).toBeUndefined();
    await cleanupWorkspaceRuntime(runtime);
  });

  it("gives a capsule no broker channel when no credentials are declared", async () => {
    const { runtime } = await prepare({ withCredentials: false });
    expect(runtime.brokerSocket).toBeUndefined();
    expect(runtime.brokerHelper).toBeUndefined();
    await cleanupWorkspaceRuntime(runtime);
  });

  it("materializes a helper and two named profiles when credentials are declared", async () => {
    const { runtime, resolved } = await prepare({ withCredentials: true });

    expect(runtime.brokerSocket).toBeDefined();
    expect(runtime.brokerHelper).toBeDefined();

    // A unix socket path is capped at 104 bytes on macOS. Placing it under the
    // session root exceeded that for the real Application Support path and
    // failed at listen() with EINVAL, so it must live in the short temp path.
    expect(runtime.brokerSocket!.startsWith(runtime.temp)).toBe(true);
    expect(Buffer.byteLength(runtime.brokerSocket!) + 1).toBeLessThanOrEqual(104);
    expect(resolved.credentials.operational?.id).toBe("target-operational");
    expect(resolved.credentials.inference?.id).toBe("central-inference");

    const helper = await readFile(runtime.brokerHelper!, "utf8");
    expect(helper).toContain("OPSCAPSULE_BROKER_TOKEN");
    expect(helper).toContain(runtime.brokerSocket!);

    const awsConfig = await readFile(
      join(runtime.targetState, ".aws", "config"),
      "utf8",
    );
    // Operational is the default profile; inference is named but not default.
    expect(awsConfig).toContain("[default]");
    expect(awsConfig).toContain(
      `credential_process = ${runtime.brokerHelper} target-operational`,
    );
    expect(awsConfig).toContain("[profile opscapsule-inference]");
    expect(awsConfig).toContain(
      `credential_process = ${runtime.brokerHelper} central-inference`,
    );

    // The environment must still name only the operational identity.
    const environment = buildWorkspaceEnvironment(runtime, resolved);
    expect(environment.AWS_PROFILE).not.toBe("opscapsule-inference");
    expect(JSON.stringify(environment)).not.toContain("central-inference");

    await cleanupWorkspaceRuntime(runtime);
  });
});

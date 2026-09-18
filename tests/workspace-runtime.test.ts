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
      { PATH: "/test/bin", AWS_ACCESS_KEY_ID: "must-not-leak" },
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

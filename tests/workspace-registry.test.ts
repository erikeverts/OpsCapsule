import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { WorkspaceRegistry } from "../src/main/workspace-registry.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscapsule-registry-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("workspace registry", () => {
  it("seeds versioned manifests with multiple targets", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();

    const catalog = await registry.catalog();
    const atlas = catalog.workspaces.find(({ id }) => id === "atlas");

    expect(catalog.errors).toEqual([]);
    expect(catalog.workspaces).toHaveLength(2);
    expect(atlas?.targets.map(({ id }) => id)).toEqual([
      "development",
      "production",
    ]);
    expect(atlas?.targets[0]?.cloud?.identity).toBe("111122223333");
    expect(atlas?.targets[1]?.cloud?.identity).toBe("999900001111");
    expect(atlas?.targets[0]?.directories).toHaveLength(2);
    expect(atlas?.targets[0]?.agent).toMatchObject({
      id: "default-agent",
      adapter: "command",
      legacy: false,
    });
  });

  it("reports invalid manifests without hiding valid ones", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    await writeFile(
      join(registry.configDirectory, "broken.yaml"),
      "apiVersion: wrong\nkind: Workspace\n",
      "utf8",
    );

    const catalog = await registry.catalog();

    expect(catalog.workspaces).toHaveLength(2);
    expect(catalog.errors).toHaveLength(1);
    expect(catalog.errors[0]?.sourcePath).toContain("broken.yaml");
  });

  it("rejects persisted agent configuration outside managed resources", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    const document = await registry.document("atlas");
    const manifest = structuredClone(document.manifest);
    manifest.metadata = { id: "unsafe-agent", name: "Unsafe Agent" };
    manifest.agentProfiles = [
      {
        id: "custom",
        name: "Custom",
        adapter: "command",
        runtime: { command: "custom-agent", args: [] },
        configuration: {
          files: [
            {
              source: "/tmp/outside.json",
              destination: ".config/custom/config.json",
            },
          ],
        },
        environment: {},
      },
    ];
    manifest.defaultAgentProfile = "custom";
    const workspaceRoot = join(registry.configDirectory, "unsafe-agent");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(join(workspaceRoot, "workspace.yaml"), stringify(manifest));

    const catalog = await registry.catalog();

    expect(catalog.workspaces.some(({ id }) => id === "unsafe-agent")).toBe(false);
    expect(
      catalog.errors.some(({ message }) =>
        message.includes("outside its managed resource directory"),
      ),
    ).toBe(true);
  });

  it("does not replace a user's existing manifest with examples", async () => {
    const root = await temporaryRoot();
    const configDirectory = join(root, "config", "workspaces");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "existing.yaml"), "invalid: true\n");
    const registry = new WorkspaceRegistry(root);

    await registry.initialize();
    const catalog = await registry.catalog();

    expect(catalog.workspaces).toHaveLength(0);
    expect(catalog.errors).toHaveLength(1);
  });

  it("resolves manifest paths with the execution host's path semantics", async () => {
    const root = await temporaryRoot();
    const configDirectory = join(root, "config", "workspaces");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "remote.yaml"),
      stringify({
        apiVersion: "opscapsule.dev/v1alpha1",
        kind: "Workspace",
        metadata: { id: "remote", name: "Remote" },
        kubernetesContexts: [
          {
            id: "cluster",
            name: "Cluster",
            source: { type: "kubeconfig", path: "kube/config", context: "c" },
          },
        ],
        directories: [
          { id: "home", name: "Home", path: "~/projects/app", access: "read-write" },
          { id: "relative", name: "Relative", path: "../repos/docs", access: "read-only" },
          { id: "absolute", name: "Absolute", path: "/srv/data", access: "read-only" },
        ],
        targets: [
          {
            id: "default",
            name: "Default",
            environment: "development",
            risk: "development",
            kubernetesContext: "cluster",
            directories: ["home", "relative", "absolute"],
            defaultDirectory: "home",
            agentRuntime: { adapter: "command", command: "$SHELL", args: [] },
            isolation: { mode: "enforced", network: { mode: "deny" } },
          },
        ],
      }),
    );
    const seeded: string[][] = [];
    const registry = new WorkspaceRegistry(root, {
      paths: {
        home: "/home/ada",
        path: posix,
        manifestDirectory: () => "/mnt/c/Users/Ada/opscapsule/config/workspaces",
      },
      demoRoot: "/home/ada/.local/state/opscapsule/demo-workspaces",
      createDemoDirectories: async (directories) => {
        seeded.push(directories);
      },
    });
    await registry.initialize();

    const target = await registry.resolveTarget("remote", "default");

    expect(seeded).toEqual([]);
    expect(target.directories.map(({ path }) => path)).toEqual([
      "/home/ada/projects/app",
      "/mnt/c/Users/Ada/opscapsule/config/repos/docs",
      "/srv/data",
    ]);
    expect(target.kubernetes?.source).toMatchObject({ path: "kube/config" });
  });

  it("seeds demo directories on the execution host with its path semantics", async () => {
    const root = await temporaryRoot();
    const seeded: string[][] = [];
    const registry = new WorkspaceRegistry(root, {
      paths: { home: "/home/ada", path: posix, manifestDirectory: () => "/mnt/c" },
      demoRoot: "/home/ada/.local/state/opscapsule/demo-workspaces",
      createDemoDirectories: async (directories) => {
        seeded.push(directories);
      },
    });

    await registry.initialize();
    const catalog = await registry.catalog();

    expect(seeded).toEqual([
      [
        "/home/ada/.local/state/opscapsule/demo-workspaces/atlas/application",
        "/home/ada/.local/state/opscapsule/demo-workspaces/atlas/documentation",
        "/home/ada/.local/state/opscapsule/demo-workspaces/borealis/operations",
      ],
    ]);
    expect(catalog.errors).toEqual([]);
    expect(catalog.workspaces[0]?.targets[0]?.defaultDirectory).toBe(
      "/home/ada/.local/state/opscapsule/demo-workspaces/atlas/application",
    );
  });

  it("creates and atomically updates a workspace document", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    const atlas = await registry.document("atlas");
    const manifest = structuredClone(atlas.manifest);
    manifest.metadata.id = "customer-platform";
    manifest.metadata.name = "Customer Platform";
    manifest.targets = manifest.targets.slice(0, 1);

    const created = await registry.create(manifest);
    expect(created.sourcePath).toBe(
      join(
        registry.configDirectory,
        "customer-platform",
        "workspace.yaml",
      ),
    );
    expect(created.revision).toHaveLength(64);

    created.manifest.metadata.description = "Edited in Workspace Studio";
    const saved = await registry.save(
      "customer-platform",
      created.revision,
      created.manifest,
    );
    expect(saved.revision).not.toBe(created.revision);
    expect(
      (await registry.document("customer-platform")).manifest.metadata
        .description,
    ).toBe("Edited in Workspace Studio");
  });

  it("uses a target agent profile override before the workspace default", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    const document = await registry.document("atlas");
    document.manifest.agentProfiles.push({
      id: "opencode",
      name: "OpenCode",
      adapter: "opencode",
      runtime: { command: "opencode", args: [] },
      configuration: { files: [] },
      environment: {},
    });
    document.manifest.targets[1]!.agentProfile = "opencode";
    await registry.save("atlas", document.revision, document.manifest);

    const development = await registry.resolveTarget("atlas", "development");
    const production = await registry.resolveTarget("atlas", "production");

    expect(development.summary.agent).toMatchObject({
      id: "default-agent",
      adapter: "command",
      legacy: false,
    });
    expect(production.summary.agent).toMatchObject({
      id: "opencode",
      adapter: "opencode",
      legacy: false,
    });
  });

  it("refuses to overwrite a workspace changed outside the editor", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    const document = await registry.document("atlas");
    await writeFile(
      document.sourcePath,
      `${document.yaml}\n# changed outside OpsCapsule\n`,
      "utf8",
    );

    await expect(
      registry.save("atlas", document.revision, document.manifest),
    ).rejects.toThrow("changed on disk");
  });

  it("keeps an existing workspace id stable", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    const document = await registry.document("atlas");
    document.manifest.metadata.id = "renamed-atlas";

    await expect(
      registry.save("atlas", document.revision, document.manifest),
    ).rejects.toThrow("cannot be changed");
  });

  it("deletes managed workspace data without touching referenced directories", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    const document = await registry.document("atlas");
    const projectPath = document.manifest.directories[0]!.path;
    const projectMarker = join(projectPath, "keep.txt");
    const statePath = join(registry.stateDirectory, "atlas", "targets", "development");
    await writeFile(projectMarker, "keep\n");
    await mkdir(statePath, { recursive: true });
    await writeFile(join(statePath, "state.json"), "{}\n");

    await registry.deleteWorkspace("atlas", document.revision);

    await expect(stat(document.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(registry.stateDirectory, "atlas"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(projectMarker, "utf8")).toBe("keep\n");
    expect((await registry.catalog()).workspaces.some(({ id }) => id === "atlas"))
      .toBe(false);
  });

  it("does not delete a workspace that changed after it was opened", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    const document = await registry.document("atlas");
    await writeFile(
      document.sourcePath,
      `${document.yaml}\n# changed outside OpsCapsule\n`,
      "utf8",
    );

    await expect(
      registry.deleteWorkspace("atlas", document.revision),
    ).rejects.toThrow("changed on disk");
    expect((await registry.document("atlas")).manifest.metadata.id).toBe("atlas");
  });

  it("does not restore examples after every workspace is deleted", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    for (const workspace of (await registry.catalog()).workspaces) {
      const document = await registry.document(workspace.id);
      await registry.deleteWorkspace(workspace.id, document.revision);
    }

    await registry.initialize();

    expect((await registry.catalog()).workspaces).toEqual([]);
  });

  it("migrates a legacy flat manifest without changing relative directory meaning", async () => {
    const root = await temporaryRoot();
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    const atlas = await registry.document("atlas");
    const manifest = structuredClone(atlas.manifest);
    manifest.metadata = { id: "legacy", name: "Legacy" };
    manifest.targets = manifest.targets.slice(0, 1);
    manifest.directories[0]!.path = "../../project";
    const legacyPath = join(registry.configDirectory, "legacy.yaml");
    await writeFile(legacyPath, stringify(manifest));

    const before = await registry.resolveTarget("legacy", "development");
    const document = await registry.document("legacy");
    const saved = await registry.save("legacy", document.revision, document.manifest);
    const after = await registry.resolveTarget("legacy", "development");

    expect(before.defaultDirectory.path).toBe(project);
    expect(after.defaultDirectory.path).toBe(project);
    expect(saved.sourcePath).toBe(
      join(registry.configDirectory, "legacy", "workspace.yaml"),
    );
  });
});

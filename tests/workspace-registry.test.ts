import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      join(registry.configDirectory, "customer-platform.yaml"),
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
});

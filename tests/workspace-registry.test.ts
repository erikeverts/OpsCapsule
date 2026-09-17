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
});


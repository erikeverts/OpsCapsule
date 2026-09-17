import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkspaceEnvironment,
  createWorkspaceRuntime,
} from "../src/main/runtime-directory.js";
import { WORKSPACES } from "../src/main/workspaces.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("workspace runtime isolation", () => {
  it("creates a separate kubeconfig and environment for every workspace", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "opscapsule-test-"));
    temporaryDirectories.push(baseDirectory);
    const [atlas, borealis] = WORKSPACES;

    expect(atlas).toBeDefined();
    expect(borealis).toBeDefined();

    const atlasRuntime = await createWorkspaceRuntime(baseDirectory, atlas!);
    const borealisRuntime = await createWorkspaceRuntime(baseDirectory, borealis!);
    const atlasEnvironment = buildWorkspaceEnvironment(atlasRuntime, atlas!, {
      PATH: "/test/bin",
    });
    const borealisEnvironment = buildWorkspaceEnvironment(
      borealisRuntime,
      borealis!,
      { PATH: "/test/bin" },
    );

    expect(atlasRuntime.kubeconfig).not.toBe(borealisRuntime.kubeconfig);
    expect(atlasEnvironment.KUBECONFIG).toBe(atlasRuntime.kubeconfig);
    expect(borealisEnvironment.KUBECONFIG).toBe(borealisRuntime.kubeconfig);
    expect(atlasEnvironment.AWS_PROFILE).toBe("atlas-prod");
    expect(borealisEnvironment.AWS_PROFILE).toBe("borealis-stage");

    const atlasConfig = await readFile(atlasRuntime.kubeconfig, "utf8");
    const borealisConfig = await readFile(borealisRuntime.kubeconfig, "utf8");
    expect(atlasConfig).toContain("current-context: atlas-prod");
    expect(borealisConfig).toContain("current-context: borealis-stage");
  });

  it("does not allow one capsule's kubeconfig changes to affect another", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "opscapsule-test-"));
    temporaryDirectories.push(baseDirectory);
    const [atlas, borealis] = WORKSPACES;
    const atlasRuntime = await createWorkspaceRuntime(baseDirectory, atlas!);
    const borealisRuntime = await createWorkspaceRuntime(baseDirectory, borealis!);
    const originalBorealisConfig = await readFile(
      borealisRuntime.kubeconfig,
      "utf8",
    );

    await writeFile(atlasRuntime.kubeconfig, "current-context: changed\n", "utf8");

    expect(await readFile(borealisRuntime.kubeconfig, "utf8")).toBe(
      originalBorealisConfig,
    );
  });
});


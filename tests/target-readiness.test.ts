import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTargetReadiness } from "../src/main/target-readiness.js";
import { WorkspaceRegistry } from "../src/main/workspace-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("target readiness", () => {
  it("reports non-mutating checks before launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "opscapsule-readiness-"));
    temporaryDirectories.push(root);
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    const document = await registry.document("atlas");
    document.manifest.agentInstructions = "Verify context before changes.";
    document.manifest.targets[0]!.isolation.mode = "context-only";
    await registry.save("atlas", document.revision, document.manifest);

    const report = await checkTargetReadiness(
      await registry.resolveTarget("atlas", "development"),
    );

    expect(report.status).toBe("attention");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "adapter", status: "pass" }),
        expect.objectContaining({ id: "executable", status: "pass" }),
        expect.objectContaining({ id: "instructions", status: "pass" }),
        expect.objectContaining({ id: "directories", status: "pass" }),
        expect.objectContaining({ id: "isolation", status: "warning" }),
      ]),
    );
  });

  it("blocks an unavailable adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "opscapsule-readiness-"));
    temporaryDirectories.push(root);
    const registry = new WorkspaceRegistry(root);
    await registry.initialize();
    const document = await registry.document("atlas");
    document.manifest.agentProfiles[0]!.adapter = "missing-adapter";
    document.manifest.targets[0]!.isolation.mode = "context-only";
    await registry.save("atlas", document.revision, document.manifest);

    const report = await checkTargetReadiness(
      await registry.resolveTarget("atlas", "development"),
    );

    expect(report.status).toBe("blocked");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "adapter", status: "fail" }),
    );
  });
});

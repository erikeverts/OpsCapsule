import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContextCatalog,
  buildContextDocument,
  capsuleDocumentPath,
  writeCapsuleContext,
  type CapsuleDocument,
} from "../src/main/workspace-context.js";
import {
  DOCUMENT_LIMIT,
  resolveDocuments,
} from "../src/shared/metadata.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function documentOnDisk(name: string, body: string): Promise<CapsuleDocument> {
  const base = await mkdtemp("/tmp/oc-docs-");
  temporary.push(base);
  const path = join(base, name);
  await writeFile(path, body);
  return {
    id: name.replace(/\..*$/, ""),
    title: "Incident runbook",
    description: "What to do when the ingest pipeline stalls",
    source: path,
    path,
  };
}

describe("documents in the catalog", () => {
  it("lists a document without including its contents", async () => {
    const document = await documentOnDisk("runbook.md", "# Runbook\n\nSecret-ish detail.");
    const catalog = buildContextCatalog({ metadata: [], documents: [document] });

    expect(catalog).toContain("## Workspace documents");
    expect(catalog).toContain("Incident runbook");
    expect(catalog).toContain("What to do when the ingest pipeline stalls");
    expect(catalog).toContain("$OPSCAPSULE_CONTEXT/documents/runbook.md");
    // The whole point of listing rather than inlining: a runbook cannot go in
    // every prompt.
    expect(catalog).not.toContain("Secret-ish detail");
  });

  it("says nothing when a workspace has neither facts nor documents", () => {
    expect(buildContextCatalog({ metadata: [], documents: [] })).toBe("");
  });

  it("records documents in context.json with capsule-relative paths", async () => {
    const document = await documentOnDisk("runbook.md", "x");
    const parsed = JSON.parse(
      buildContextDocument({ metadata: [], documents: [document] }),
    );
    expect(parsed.documents).toEqual([
      {
        id: "runbook",
        title: "Incident runbook",
        description: "What to do when the ingest pipeline stalls",
        path: "documents/runbook.md",
      },
    ]);
    // The host path must not travel into the capsule.
    expect(JSON.stringify(parsed)).not.toContain("/tmp/oc-docs-");
  });
});

describe("documents in the capsule", () => {
  it("copies documents in and makes them read-only", async () => {
    const document = await documentOnDisk("runbook.md", "# Runbook\n");
    const capsule = await mkdtemp("/tmp/oc-capsule-");
    temporary.push(capsule);

    await writeCapsuleContext(capsule, { metadata: [], documents: [document] });

    const delivered = join(capsule, capsuleDocumentPath(document));
    expect(await readFile(delivered, "utf8")).toBe("# Runbook\n");
    // Reference material is not the agent's to edit, and a capsule must not
    // be able to rewrite what the next one is told.
    expect((await stat(delivered)).mode & 0o777).toBe(0o400);
  });

  it("writes no documents directory when there are none", async () => {
    const capsule = await mkdtemp("/tmp/oc-capsule-empty-");
    temporary.push(capsule);
    await writeCapsuleContext(capsule, { metadata: [], documents: [] });
    await expect(stat(join(capsule, "documents"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("document resolution", () => {
  const doc = (id: string, title: string): CapsuleDocument => ({
    id,
    title,
    source: `resources/documents/${id}.md`,
    path: `/managed/${id}.md`,
  });

  it("lets a target replace a workspace document by id", () => {
    const resolved = resolveDocuments(
      [doc("runbook", "Generic runbook"), doc("architecture", "Architecture")],
      [doc("runbook", "Production runbook")],
    );
    expect(resolved).toHaveLength(2);
    expect(resolved.find((d) => d.id === "runbook")!.title).toBe(
      "Production runbook",
    );
  });

  it("adds a document that exists only on the target", () => {
    const resolved = resolveDocuments([], [doc("prod-only", "Production only")]);
    expect(resolved.map((d) => d.id)).toEqual(["prod-only"]);
  });

  it("has a limit, because every document is listed on every turn", () => {
    expect(DOCUMENT_LIMIT).toBeGreaterThan(0);
  });
});

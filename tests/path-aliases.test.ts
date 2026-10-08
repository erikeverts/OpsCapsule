import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverPathAliases } from "../src/main/isolation/path-aliases.js";

async function fixture(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "opscapsule-alias-")));
}

/**
 * Keeps only the aliases created by a test. System directories are themselves
 * reached through links on macOS (/var stands in for /private/var), so a
 * folder under a temporary directory genuinely has names beyond the fixture's
 * own. Reporting those is correct and not what these tests are about.
 */
async function aliasesWithin(root: string, path: string): Promise<string[]> {
  const found = await discoverPathAliases(path);
  return found.filter((alias) => alias.startsWith(root));
}

describe("finding other names for a picked folder", () => {
  it("reports nothing for a folder no link points at", async () => {
    const root = await fixture();
    const plain = join(root, "plain");
    await mkdir(plain);
    expect(await aliasesWithin(root, plain)).toEqual([]);
  });

  it("finds a link that stands in for a parent of the folder", async () => {
    // The shape the open panel destroys: the folder is picked through a link
    // and comes back under its real name.
    const root = await fixture();
    const store = join(root, "storage", "Account", "work");
    await mkdir(join(store, "project"), { recursive: true });
    await symlink(store, join(root, "work"));

    const aliases = await aliasesWithin(root, join(store, "project"));

    expect(aliases).toEqual([join(root, "work", "project")]);
  });

  it("does not report the folder's own name", async () => {
    const root = await fixture();
    const real = join(root, "real");
    await mkdir(real);
    await symlink(real, join(root, "link"));
    const aliases = await aliasesWithin(root, join(root, "link"));
    // Picked through the link, the real path is already the configured one.
    expect(aliases).not.toContain(await realpath(real));
  });

  it("ignores a link pointing somewhere unrelated", async () => {
    const root = await fixture();
    await mkdir(join(root, "wanted"));
    await mkdir(join(root, "other"));
    await symlink(join(root, "other"), join(root, "decoy"));
    expect(await aliasesWithin(root, join(root, "wanted"))).toEqual([]);
  });

  it("ignores a link that reaches nothing", async () => {
    const root = await fixture();
    await mkdir(join(root, "wanted"));
    await symlink(join(root, "missing"), join(root, "broken"));
    expect(await aliasesWithin(root, join(root, "wanted"))).toEqual([]);
  });

  it("does not claim links kept outside the folder's own location", async () => {
    // A stated limitation rather than an oversight: searching everywhere would
    // mean searching the whole filesystem.
    const root = await fixture();
    const elsewhere = await fixture();
    const wanted = join(root, "wanted");
    await mkdir(wanted);
    await symlink(wanted, join(elsewhere, "shortcut"));
    expect(await aliasesWithin(elsewhere, wanted)).toEqual([]);
  });
});

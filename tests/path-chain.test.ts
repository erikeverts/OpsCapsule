import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePathChain } from "../src/main/isolation/path-chain.js";

async function fixture(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "opscapsule-chain-")));
}

describe("resolving every path form of a configured directory", () => {
  it("returns just the path when nothing is a link", async () => {
    const root = await fixture();
    const plain = join(root, "plain");
    await mkdir(plain);
    expect(await resolvePathChain(plain)).toEqual([plain]);
  });

  it("includes the configured path, the link passed through, and the target", async () => {
    // The shape that failed in practice: a link whose target sits behind
    // another link, as cloud storage directories are arranged.
    const root = await fixture();
    const store = join(root, "storage", "Account");
    await mkdir(join(store, "work"), { recursive: true });
    await symlink(store, join(root, "Account"));
    await symlink(join(root, "Account", "work"), join(root, "work"));

    const chain = await resolvePathChain(join(root, "work"));

    expect(chain).toContain(join(root, "work"));
    // The intermediate link must be present in its own right, or resolution
    // stops there and the directory stays unreachable.
    expect(chain).toContain(join(root, "Account"));
    expect(chain).toContain(join(store, "work"));
  });

  it("follows a link that points somewhere relative", async () => {
    const root = await fixture();
    await mkdir(join(root, "target"));
    await symlink("target", join(root, "link"));
    const chain = await resolvePathChain(join(root, "link"));
    expect(chain).toContain(join(root, "link"));
    expect(chain).toContain(join(root, "target"));
  });

  it("does not report a path form twice", async () => {
    const root = await fixture();
    await mkdir(join(root, "target"));
    await symlink(join(root, "target"), join(root, "link"));
    const chain = await resolvePathChain(join(root, "link"));
    expect(new Set(chain).size).toBe(chain.length);
  });

  it("refuses a cycle rather than following it forever", async () => {
    const root = await fixture();
    await symlink(join(root, "b"), join(root, "a"));
    await symlink(join(root, "a"), join(root, "b"));
    await expect(resolvePathChain(join(root, "a"))).rejects.toThrow(
      /Too many symbolic links/,
    );
  });

  it("keeps the tail when a link sits part way along the path", async () => {
    // Only the directory is a link; the file beneath it is reached through it.
    const root = await fixture();
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "file.txt"), "");
    await symlink(join(root, "real"), join(root, "linked"));
    const chain = await resolvePathChain(join(root, "linked", "file.txt"));
    expect(chain).toContain(join(root, "linked", "file.txt"));
    expect(chain).toContain(join(root, "linked"));
    expect(chain).toContain(join(root, "real", "file.txt"));
  });
});

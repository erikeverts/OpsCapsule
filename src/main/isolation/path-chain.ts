import { lstat, readlink, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

// Matches the kernel's own ELOOP threshold closely enough to refuse a cycle
// rather than walking one forever.
const MAX_SYMLINK_HOPS = 40;

/**
 * Every path form by which a configured directory can be reached: the path as
 * configured, each symbolic link passed through on the way, and the final
 * resolved path.
 *
 * The sandbox matches on paths, not inodes, so allowing only the resolved path
 * leaves the agent unable to reach the directory by the name it was given. A
 * symbolic link in the middle of the chain has to be readable in its own
 * right, or resolution stops there.
 *
 * Allowing a link node does not widen access to its siblings: the sandbox
 * canonicalises a deeper path before matching it, and the canonical form of a
 * sibling still falls under the denied user-data roots.
 */
export async function resolvePathChain(input: string): Promise<string[]> {
  const forms = new Set<string>();
  const start = resolve(input);
  forms.add(start);

  let resolved = "";
  let remaining = start.split(sep).filter(Boolean);
  let hops = 0;

  while (remaining.length > 0) {
    const name = remaining.shift() as string;
    const candidate = `${resolved}${sep}${name}`;

    let entry;
    try {
      entry = await lstat(candidate);
    } catch {
      // A component that cannot be inspected cannot be a link to follow.
      resolved = candidate;
      continue;
    }

    if (!entry.isSymbolicLink()) {
      resolved = candidate;
      continue;
    }

    if ((hops += 1) > MAX_SYMLINK_HOPS) {
      throw new Error(`Too many symbolic links while resolving '${input}'`);
    }
    forms.add(candidate);

    const target = await readlink(candidate);
    const next = isAbsolute(target) ? target : resolve(resolved, target);
    // Continue from the target, keeping whatever tail is still unresolved.
    remaining = [...next.split(sep).filter(Boolean), ...remaining];
    resolved = "";
  }

  forms.add(await realpath(start));
  return [...forms];
}

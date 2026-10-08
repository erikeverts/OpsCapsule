import { lstat, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * Every directory on the path from the filesystem root to `path`, longest
 * first.
 */
function ancestorChain(path: string): string[] {
  const parts = path.split(sep).filter(Boolean);
  const chain: string[] = [];
  for (let depth = parts.length; depth > 0; depth -= 1) {
    chain.push(sep + parts.slice(0, depth).join(sep));
  }
  chain.push(sep);
  return chain;
}

/**
 * Other paths that reach the same directory through a symbolic link.
 *
 * The macOS open panel resolves symbolic links before handing a path back, so
 * a folder picked through a link arrives under its real name. An agent told to
 * use the link's name is then refused, because that name was never allowed.
 * The link cannot be recovered from the resolved path alone: finding every
 * name that points at a directory would mean searching the whole filesystem.
 *
 * The search is limited to the directories the folder itself sits under. That
 * is not an arbitrary boundary like the home directory: it is exactly the set
 * of places where a link can sit and still describe this folder by its own
 * location. A link kept somewhere unrelated is not found, and is not claimed
 * to be.
 */
export async function discoverPathAliases(path: string): Promise<string[]> {
  const real = await realpath(path);
  const chain = ancestorChain(real);
  const onChain = new Set(chain);
  const aliases = new Set<string>();

  for (const directory of chain) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      // A directory that cannot be listed cannot be searched. Nothing to
      // report, and no reason to fail a folder the user has already chosen.
      continue;
    }

    for (const name of entries) {
      const candidate = join(directory, name);
      if (onChain.has(candidate)) {
        continue;
      }
      try {
        if (!(await lstat(candidate)).isSymbolicLink()) {
          continue;
        }
        const target = await realpath(candidate);
        if (!onChain.has(target)) {
          continue;
        }
        // The link stands in for one of the ancestors, so the folder is
        // reachable by swapping that ancestor for the link.
        const alias = candidate + real.slice(target.length);
        if (alias !== real) {
          aliases.add(alias);
        }
      } catch {
        // A broken or unreadable link reaches nothing.
      }
    }
  }

  return [...aliases].sort();
}

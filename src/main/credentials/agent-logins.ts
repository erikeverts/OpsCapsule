import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentLoginOption } from "../../shared/contracts.js";

/**
 * Discovers the provider logins an agent already holds on the host, so a
 * credential can be selected from a list in the same way an AWS profile is.
 *
 * Only identifiers are read. No token value ever leaves this module, and none
 * is returned to the renderer.
 */
interface AgentLoginStore {
  readonly provider: string;
  readonly label: string;
  readonly path: () => string;
}

const stores: AgentLoginStore[] = [
  {
    provider: "opencode",
    label: "OpenCode",
    path: () =>
      join(homedir(), ".local", "share", "opencode", "auth.json"),
  },
];

function storeFor(provider: string): AgentLoginStore {
  const store = stores.find((candidate) => candidate.provider === provider);
  if (!store) {
    throw new Error(`No credential store is known for provider '${provider}'.`);
  }
  return store;
}

async function readStore(
  store: AgentLoginStore,
): Promise<Record<string, unknown>> {
  const contents = await readFile(store.path(), "utf8");
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${store.label} credentials are not in the expected form.`);
  }
  return parsed as Record<string, unknown>;
}

export async function discoverAgentLogins(): Promise<AgentLoginOption[]> {
  const discovered = await Promise.all(
    stores.map(async (store) => {
      let entries: Record<string, unknown>;
      try {
        entries = await readStore(store);
      } catch {
        // A missing or unreadable store simply offers nothing to select.
        return [];
      }
      return Object.entries(entries).map(([id, value]) => ({
        provider: store.provider,
        providerLabel: store.label,
        id,
        type:
          value && typeof value === "object" && "type" in value
            ? String((value as { type: unknown }).type)
            : "unknown",
      }));
    }),
  );
  return discovered.flat();
}

/**
 * Extracts a single login from the host store.
 *
 * Importing the whole file would carry every other provider the user has ever
 * authenticated into the capsule. Only the selected login is taken.
 */
export async function readAgentLogin(
  provider: string,
  loginId: string,
): Promise<string> {
  const store = storeFor(provider);
  const entries = await readStore(store);
  const entry = entries[loginId];
  if (entry === undefined) {
    throw new Error(
      `${store.label} has no login for '${loginId}'. Sign in on the host first.`,
    );
  }
  return `${JSON.stringify({ [loginId]: entry }, null, 2)}\n`;
}

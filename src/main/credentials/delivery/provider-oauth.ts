import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialReference } from "../../../shared/credentials.js";
import type {
  CredentialDeliveryAdapter,
  DeliveryContext,
} from "./types.js";

/**
 * Provider logins such as GitHub Copilot are consumed by reading a file the
 * agent expects to exist. There is no hook to spawn, so nothing can be pulled
 * at point of use: the credential has to be written into the capsule at launch
 * and removed at teardown.
 *
 * This is deliberately weaker than the pull path and the difference is not
 * hidden: the secret is briefly at rest inside the boundary. In exchange the
 * capsule needs no channel back to the main process at all, so a Copilot-only
 * capsule keeps `allowUnixSockets` empty and opens no hole in the sandbox.
 *
 * The file lives in scope-appropriate agent state, so a user-scoped login is
 * written once per capsule rather than copied into a workspace resource
 * directory, and the real home directory is never exposed.
 */
interface ProviderDeliveryPolicy {
  readonly destination: (agentState: string) => string;
  /**
   * Whether the consumer needs the refresh token to function.
   *
   * Stripping it is the safer default, but it is not always possible. OpenCode
   * stores a GitHub Copilot login as `{access, refresh, expires: 0}`: the
   * zero expiry means it treats the access token as stale and mints a fresh
   * Copilot API token from the refresh token on demand. Removing it would
   * deliver a credential that fails on first use, so for this provider the
   * refresh token is retained and the weaker exposure is accepted explicitly
   * rather than silently.
   */
  readonly retainsRefreshToken: boolean;
}

const providerPolicies: Record<string, ProviderDeliveryPolicy> = {
  // OpenCode resolves auth.json under XDG_DATA_HOME, which the OpenCode
  // adapter points at <agentState>/data.
  opencode: {
    destination: (agentState) =>
      join(agentState, "data", "opencode", "auth.json"),
    retainsRefreshToken: true,
  },
};

export function policyFor(
  reference: CredentialReference,
): ProviderDeliveryPolicy {
  const providerId = reference.providerId;
  if (!providerId) {
    throw new Error(
      `Credential reference '${reference.id}' needs a providerId to be delivered.`,
    );
  }
  const policy = providerPolicies[providerId];
  if (!policy) {
    throw new Error(
      `No credential delivery is implemented for provider '${providerId}'.`,
    );
  }
  return policy;
}

function destinationFor(
  reference: CredentialReference,
  agentState: string,
): string {
  return policyFor(reference).destination(agentState);
}

/**
 * A refresh token is long-lived and must never enter a capsule: it would let
 * whatever runs there mint new access tokens indefinitely, outliving the
 * session and defeating revocation. The main process keeps it and the capsule
 * receives only the short-lived access token.
 */
export function withoutRefreshTokens(secret: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    // Not JSON: it cannot be selectively stripped, so it is passed through
    // unchanged rather than silently corrupted.
    return secret;
  }
  if (!parsed || typeof parsed !== "object") {
    return secret;
  }
  const stripped = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
      if (!value || typeof value !== "object") {
        return [key, value];
      }
      const { refresh: _refresh, ...rest } = value as Record<string, unknown>;
      return [key, rest];
    }),
  );
  return `${JSON.stringify(stripped, null, 2)}\n`;
}

export class ProviderOAuthDelivery implements CredentialDeliveryAdapter {
  readonly id = "provider-oauth";
  readonly transport = "materialize" as const;

  async prepare(context: DeliveryContext): Promise<void> {
    for (const { reference } of context.assignments) {
      const policy = policyFor(reference);
      const destination = destinationFor(reference, context.agentState);
      const secret = await context.readSecret(reference);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(
        destination,
        policy.retainsRefreshToken ? secret : withoutRefreshTokens(secret),
        { encoding: "utf8", mode: 0o600 },
      );
    }
  }

  async teardown(context: DeliveryContext): Promise<void> {
    for (const { reference } of context.assignments) {
      await rm(destinationFor(reference, context.agentState), { force: true });
    }
  }
}

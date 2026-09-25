import type { CredentialReference } from "../../../shared/credentials.js";

/**
 * Credential delivery is provider-specific; the broker is not.
 *
 * Consumers differ fundamentally in how they will accept a credential, and the
 * difference is not cosmetic:
 *
 *   - **pull**: the consumer spawns a helper at the moment it needs a
 *     credential. AWS `credential_process` and Claude Code's
 *     `awsCredentialExport` work this way. Nothing is stored in the capsule,
 *     but the capsule needs a live channel back to the main process.
 *
 *   - **materialize**: the consumer only reads a file it expects to exist.
 *     GitHub Copilot through OpenCode works this way - there is no hook to
 *     spawn, so the credential must be written into the capsule at launch and
 *     removed at teardown. This is weaker, because the secret is briefly at
 *     rest inside the boundary, but it needs no channel at all.
 *
 * Choosing per adapter means a capsule only opens a broker socket when
 * something actually pulls, rather than whenever any credential exists.
 */
export type DeliveryTransport = "pull" | "materialize";

export interface CredentialAssignment {
  readonly role: "operational" | "inference";
  readonly reference: CredentialReference;
}

export interface DeliveryContext {
  /** Capsule-visible absolute path of the broker helper, when one exists. */
  readonly helperPath?: string;
  readonly targetState: string;
  readonly agentState: string;
  readonly assignments: readonly CredentialAssignment[];
  /** Reads a stored secret. Only used by materialize adapters. */
  readonly readSecret: (reference: CredentialReference) => Promise<string>;
}

export interface CredentialDeliveryAdapter {
  readonly id: string;
  readonly transport: DeliveryTransport;
  /** Writes whatever the consumer expects to find inside the capsule. */
  prepare(context: DeliveryContext): Promise<void>;
  /** Removes any secret this adapter materialized. */
  teardown?(context: DeliveryContext): Promise<void>;
  /**
   * Formats a broker response for this consumer. Pull adapters only: the wire
   * payload is provider-specific, so the broker itself stays neutral.
   */
  formatResponse?(secret: string): string;
}

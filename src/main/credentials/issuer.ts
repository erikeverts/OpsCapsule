import { exportProfileCredentials } from "./aws-profile.js";
import type { CredentialIssuer } from "./broker.js";
import { CredentialDeliveryRegistry } from "./delivery/registry.js";
import {
  CredentialStore,
  scopeContext,
  type CredentialStoreContext,
} from "./store.js";

/**
 * Reads a stored secret and hands it to the delivery adapter for formatting.
 *
 * The issuer stays provider-neutral: it never inspects the credential shape,
 * so supporting a new provider means adding a delivery adapter rather than
 * editing the broker path.
 *
 * Minting genuinely short-lived credentials through STS AssumeRole is a
 * separate slice. Until then an `aws-role` reference is refused rather than
 * silently treated as a long-lived credential, so nothing claims a lifetime it
 * does not have.
 */
export function createCredentialIssuer(
  store: CredentialStore,
  context: Required<CredentialStoreContext>,
  delivery = new CredentialDeliveryRegistry(),
): CredentialIssuer {
  return async (reference) => {
    if (reference.kind === "aws-profile") {
      // No secret is stored for a profile. Credentials are minted here, in the
      // main process, so the SSO cache and role chain stay out of the capsule.
      if (!reference.sourceProfile) {
        throw new Error(
          `Credential reference '${reference.id}' does not name an AWS profile.`,
        );
      }
      return exportProfileCredentials(reference.sourceProfile);
    }
    if (reference.kind === "aws-role") {
      throw new Error(
        `Credential reference '${reference.id}' requires STS role assumption, which is not implemented yet.`,
      );
    }
    const secret = await store.read(
      reference,
      scopeContext(reference.scope, context),
    );
    return delivery.formatResponse(reference, secret);
  };
}

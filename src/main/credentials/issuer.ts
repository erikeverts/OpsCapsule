import type {
  BrokeredCredentials,
  CredentialIssuer,
} from "./broker.js";
import {
  CredentialStore,
  scopeContext,
  type CredentialStoreContext,
} from "./store.js";

/**
 * Turns a stored secret into the short-lived credentials handed to a capsule.
 *
 * The stored payload is the credential material the user authenticated with.
 * Minting genuinely short-lived credentials through STS AssumeRole is a
 * separate slice; until then an `aws-role` reference is refused rather than
 * silently treated as a long-lived credential, so nothing claims a lifetime it
 * does not have.
 */
export function createCredentialIssuer(
  store: CredentialStore,
  context: Required<CredentialStoreContext>,
): CredentialIssuer {
  return async (reference) => {
    if (reference.kind === "provider-oauth") {
      throw new Error(
        `Credential reference '${reference.id}' is a provider login and is not delivered over the AWS broker path.`,
      );
    }
    if (reference.kind === "aws-role") {
      throw new Error(
        `Credential reference '${reference.id}' requires STS role assumption, which is not implemented yet.`,
      );
    }

    const raw = await store.read(reference, scopeContext(reference.scope, context));
    const parsed = JSON.parse(raw) as Partial<BrokeredCredentials>;
    if (!parsed.accessKeyId || !parsed.secretAccessKey || !parsed.sessionToken) {
      throw new Error(
        `Stored credential '${reference.id}' is missing required fields.`,
      );
    }
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      sessionToken: parsed.sessionToken,
      ...(parsed.expiration ? { expiration: parsed.expiration } : {}),
    };
  };
}

// SPIKE (ADR 0007). This module is not wired into the launch path yet. It
// exists to prove the credential-delivery mechanism before the broker is
// built for real, and its tests are the record of what was proven.
//
// The helper is the process that AWS `credential_process` and Claude Code's
// `awsCredentialExport` invoke from inside a capsule. It must:
//
//   - never read stdin, because Claude Code fails the whole credential chain
//     after 60 seconds and explicitly calls out "a credential_process helper
//     that waits for input it can't receive" as a failure mode;
//   - fail closed on any authority problem rather than emit partial output;
//   - emit one payload that satisfies both consumers; and
//   - never place a secret in its own argv, which is world-readable via `ps`.

export interface BrokeredCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** ISO 8601. Optional for both consumers, but omitting it caps caching at one hour. */
  readonly expiration?: string;
}

export interface BrokerRequest {
  readonly token: string;
  readonly referenceId: string;
}

export type CredentialResolver = (
  referenceId: string,
) => Promise<BrokeredCredentials>;

export class BrokerAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerAuthorityError";
  }
}

/**
 * A per-session authority. A token is bound to one session and to an explicit
 * set of credential references, so a capsule cannot ask the broker for a
 * reference that its target does not use, and a token recovered from one
 * session is worthless in another.
 */
export interface SessionBrokerAuthority {
  readonly token: string;
  verify(request: BrokerRequest): void;
  revoke(): void;
}

export function createSessionBrokerAuthority(
  token: string,
  allowedReferenceIds: readonly string[],
): SessionBrokerAuthority {
  const allowed = new Set(allowedReferenceIds);
  let revoked = false;
  return {
    token,
    verify(request) {
      if (revoked) {
        throw new BrokerAuthorityError("The broker session has been revoked.");
      }
      // Length-independent comparison is not required here because the token
      // never leaves the local machine, but a constant-time compare would be
      // the safer default if this is ever exposed over a socket.
      if (request.token !== token) {
        throw new BrokerAuthorityError("The broker session token is not valid.");
      }
      if (!allowed.has(request.referenceId)) {
        throw new BrokerAuthorityError(
          `Credential reference is not in scope for this session: ${request.referenceId}`,
        );
      }
    },
    revoke() {
      revoked = true;
    },
  };
}

/**
 * The single payload both consumers accept.
 *
 * `Version: 1` plus top-level keys is the AWS `credential_process` contract.
 * Claude Code documents that it also accepts "the flat output from
 * `aws configure export-credentials --format process` ... with the same keys
 * at the top level", so one helper serves both without branching on consumer.
 */
export function formatBrokeredCredentials(
  credentials: BrokeredCredentials,
): string {
  const payload: Record<string, string | number> = {
    Version: 1,
    AccessKeyId: credentials.accessKeyId,
    SecretAccessKey: credentials.secretAccessKey,
    SessionToken: credentials.sessionToken,
  };
  if (credentials.expiration) {
    payload.Expiration = credentials.expiration;
  }
  return `${JSON.stringify(payload)}\n`;
}

/**
 * Reads the request from the environment rather than argv. Process arguments
 * are readable by any other process on the machine, and inside a capsule that
 * includes the agent and both shells.
 */
export function readBrokerRequest(
  environment: Readonly<Record<string, string | undefined>>,
): BrokerRequest {
  const token = environment.OPSCAPSULE_BROKER_TOKEN;
  const referenceId = environment.OPSCAPSULE_BROKER_REFERENCE;
  if (!token || !referenceId) {
    throw new BrokerAuthorityError(
      "The broker request is missing its session token or credential reference.",
    );
  }
  return { token, referenceId };
}

export async function handleBrokerRequest(
  request: BrokerRequest,
  authority: SessionBrokerAuthority,
  resolve: CredentialResolver,
): Promise<string> {
  authority.verify(request);
  const credentials = await resolve(request.referenceId);
  return formatBrokeredCredentials(credentials);
}

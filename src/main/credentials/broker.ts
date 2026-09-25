import { chmod, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { CredentialReference } from "../../shared/credentials.js";

/**
 * The broker socket is the only route out of a capsule back into the
 * application, so everything arriving on it is treated as untrusted input with
 * the same seriousness as the renderer IPC surface.
 *
 * The transport is HTTP over a unix socket, spoken by `curl --unix-socket`.
 * A raw line protocol over `nc` was tried first and is quietly broken: `nc`
 * exits as soon as its stdin reaches EOF, so it discards any response that
 * does not arrive almost immediately. Resolving a real AWS profile takes
 * hundreds of milliseconds, so every genuine credential request was lost while
 * a synchronous test stub passed. HTTP also gives request framing and status
 * codes for free, and `curl` is present by default on macOS and on
 * effectively every Linux distribution.
 *
 * Deliberate properties:
 *   - request/response only, with no body read from the capsule;
 *   - the capsule may name a credential *reference*, never a path, command,
 *     account, or role, so it cannot widen its own access;
 *   - every refusal is identical, because a capsule should not be able to
 *     discover which references exist by comparing responses.
 */
export const BROKER_TOKEN_HEADER = "x-opscapsule-token";
export const BROKER_REFERENCE_HEADER = "x-opscapsule-reference";

const REQUEST_TIMEOUT_MS = 60_000;
const REFERENCE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type CredentialIssuer = (
  reference: CredentialReference,
) => Promise<string>;

export interface BrokerAuditEvent {
  readonly referenceId: string;
  readonly outcome: "issued" | "denied";
  readonly reason?: string;
}

export interface BrokerSessionOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly references: readonly CredentialReference[];
  readonly issue: CredentialIssuer;
  readonly onAudit?: (event: BrokerAuditEvent) => void;
}

export class CredentialBrokerSession {
  private server?: Server;
  private revoked = false;
  private readonly references: Map<string, CredentialReference>;

  constructor(private readonly options: BrokerSessionOptions) {
    this.references = new Map(
      options.references.map((reference) => [reference.id, reference]),
    );
  }

  async listen(): Promise<void> {
    if (this.server) {
      throw new Error("The broker session is already listening.");
    }
    assertUsableSocketPath(this.options.socketPath);
    await rm(this.options.socketPath, { force: true });

    const server = createServer((request, response) => {
      // Nothing the capsule sends in a body is ever used.
      request.resume();

      const deny = (referenceId: string, reason: string) => {
        this.options.onAudit?.({ referenceId, outcome: "denied", reason });
        response.writeHead(403, { "content-type": "application/json" });
        response.end(`${JSON.stringify({ Error: "Credential request denied." })}\n`);
      };

      const token = header(request.headers[BROKER_TOKEN_HEADER]);
      const referenceId = header(request.headers[BROKER_REFERENCE_HEADER]);

      if (!referenceId || !REFERENCE_PATTERN.test(referenceId)) {
        deny("unknown", "malformed credential reference");
        return;
      }
      if (this.revoked) {
        deny(referenceId, "session revoked");
        return;
      }
      if (!token || !timingSafeEquals(token, this.options.token)) {
        deny(referenceId, "invalid session token");
        return;
      }
      const reference = this.references.get(referenceId);
      if (!reference) {
        deny(referenceId, "reference not in scope for this session");
        return;
      }

      void this.options
        .issue(reference)
        .then((payload) => {
          this.options.onAudit?.({ referenceId, outcome: "issued" });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(payload);
        })
        .catch((error: Error) => deny(referenceId, error.message));
    });

    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = 10_000;

    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    // Defence in depth behind the sandbox allowance: only this user can
    // connect, even if the socket path were reachable from elsewhere.
    await chmod(this.options.socketPath, 0o600);
  }

  /** Immediate revocation. Further requests are refused. */
  revoke(): void {
    this.revoked = true;
  }

  async close(): Promise<void> {
    this.revoke();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(this.options.socketPath, { force: true });
  }
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A unix socket address is a fixed-size field: 104 bytes on macOS and 108 on
 * Linux. Exceeding it fails at listen() with a bare EINVAL that says nothing
 * about the cause, so it is checked up front.
 */
export function assertUsableSocketPath(socketPath: string): void {
  const limit = process.platform === "darwin" ? 104 : 108;
  const length = Buffer.byteLength(socketPath) + 1;
  if (length > limit) {
    throw new Error(
      `The broker socket path is ${length} bytes, over the ${limit}-byte limit on this platform: ${socketPath}`,
    );
  }
}

function timingSafeEquals(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    mismatch |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

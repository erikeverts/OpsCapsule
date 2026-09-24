import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import type { CredentialReference } from "../../shared/credentials.js";

/**
 * The broker socket is the only route out of a capsule back into the
 * application, so everything arriving on it is treated as untrusted input with
 * the same seriousness as the renderer IPC surface.
 *
 * Deliberate properties of the protocol:
 *   - request/response only, one request per connection;
 *   - the capsule may name a credential *reference*, never a path, command,
 *     account, or role, so it cannot widen its own access;
 *   - requests are size- and time-bounded; and
 *   - failures return a generic error, because a capsule should not be able to
 *     enumerate which references exist by comparing messages.
 */
const MAX_REQUEST_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 5_000;

const brokerRequestSchema = z
  .object({
    token: z.string().min(1).max(512),
    referenceId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict();

export type BrokerRequest = z.infer<typeof brokerRequestSchema>;

/**
 * The broker is provider-neutral. It authenticates the request, enforces
 * scope, and returns an already-formatted payload. What that payload looks
 * like belongs to the delivery adapter for the credential's kind, so adding a
 * provider never means changing the broker.
 */
export type CredentialIssuer = (
  reference: CredentialReference,
) => Promise<string>;

export interface BrokerSessionOptions {
  readonly socketPath: string;
  readonly token: string;
  /** The only references this capsule may request. */
  readonly references: readonly CredentialReference[];
  readonly issue: CredentialIssuer;
  readonly onAudit?: (event: BrokerAuditEvent) => void;
}

export interface BrokerAuditEvent {
  readonly referenceId: string;
  readonly outcome: "issued" | "denied";
  readonly reason?: string;
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
    await rm(this.options.socketPath, { force: true });
    const server = createServer((socket) => {
      void this.handleConnection(socket);
    });
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

  private audit(event: BrokerAuditEvent): void {
    this.options.onAudit?.(event);
  }

  private async handleConnection(socket: Socket): Promise<void> {
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (referenceId: string, reason: string) => {
      if (settled) {
        return;
      }
      settled = true;
      this.audit({ referenceId, outcome: "denied", reason });
      // Generic message: a capsule must not learn why it was refused.
      socket.end(`${JSON.stringify({ Error: "Credential request denied." })}\n`);
    };

    socket.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        fail("unknown", "request exceeded the maximum size");
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(0x0a) && size < MAX_REQUEST_BYTES) {
        return;
      }
      void this.respond(socket, Buffer.concat(chunks).toString("utf8"), fail, () => {
        settled = true;
      });
    });
    socket.on("error", () => socket.destroy());
  }

  private async respond(
    socket: Socket,
    raw: string,
    fail: (referenceId: string, reason: string) => void,
    markSettled: () => void,
  ): Promise<void> {
    let request: BrokerRequest;
    try {
      request = brokerRequestSchema.parse(JSON.parse(raw));
    } catch {
      fail("unknown", "malformed request");
      return;
    }

    if (this.revoked) {
      fail(request.referenceId, "session revoked");
      return;
    }
    if (!timingSafeEquals(request.token, this.options.token)) {
      fail(request.referenceId, "invalid session token");
      return;
    }
    const reference = this.references.get(request.referenceId);
    if (!reference) {
      fail(request.referenceId, "reference not in scope for this session");
      return;
    }

    let payload: string;
    try {
      payload = await this.options.issue(reference);
    } catch (error) {
      fail(request.referenceId, (error as Error).message);
      return;
    }

    markSettled();
    this.audit({ referenceId: reference.id, outcome: "issued" });
    socket.end(payload);
  }

  /** Immediate revocation. Outstanding sockets are dropped. */
  revoke(): void {
    this.revoked = true;
  }

  async close(): Promise<void> {
    this.revoke();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(this.options.socketPath, { force: true });
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

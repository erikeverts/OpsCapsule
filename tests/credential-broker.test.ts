import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialBrokerSession,
  type BrokerAuditEvent,
} from "../src/main/credentials/broker.js";
import {
  createBrokerToken,
  writeBrokerHelper,
} from "../src/main/credentials/helper.js";
import {
  AwsCredentialDelivery,
  buildCapsuleAwsConfig,
  INFERENCE_PROFILE_NAME,
} from "../src/main/credentials/delivery/aws.js";
import {
  ProviderOAuthDelivery,
  withoutRefreshTokens,
} from "../src/main/credentials/delivery/provider-oauth.js";
import { CredentialDeliveryRegistry } from "../src/main/credentials/delivery/registry.js";
import {
  CredentialNotStoredError,
  CredentialStorageUnavailableError,
  CredentialStore,
  credentialSecretPath,
} from "../src/main/credentials/store.js";
import { buildSandboxRuntimeSettings } from "../src/main/isolation/sandbox-runtime.js";
import {
  cleanupSandboxCommand,
  initializeSandboxRuntime,
  resetSandboxRuntime,
  wrapSandboxedLaunch,
} from "../src/main/isolation/sandbox-command.js";
import {
  assertUsableSecret,
  credentialStatuses,
  requireReference,
  storageContextFor,
} from "../src/main/credentials/service.js";
import type { CredentialReference } from "../src/shared/credentials.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

const macOsSandboxAvailable =
  process.platform === "darwin" &&
  spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)\n(allow default)", "/usr/bin/true"],
    { stdio: "ignore" },
  ).status === 0 &&
  spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

const operational: CredentialReference = {
  id: "target-operational",
  name: "Customer production",
  kind: "aws-role",
  scope: "target",
  region: "eu-west-1",
  expectedAccountId: "111122223333",
};

const inference: CredentialReference = {
  id: "central-inference",
  name: "Central Bedrock",
  kind: "aws-role",
  scope: "user",
  region: "us-east-1",
};

const awsDelivery = new AwsCredentialDelivery();
const issued = {
  accessKeyId: "ASIAFROMMAINPROCESS",
  secretAccessKey: "secret",
  sessionToken: "session",
  expiration: "2026-01-01T00:00:00Z",
};
const awsPayload = awsDelivery.formatResponse(JSON.stringify(issued));

/** Reversible stand-in for Electron safeStorage. */
function fakeEncryptor(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) =>
      Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("enc:")) {
        throw new Error("not decryptable");
      }
      return text.slice(4);
    },
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const base = await mkdtemp(
    join(process.platform === "darwin" ? "/private/tmp" : "/tmp", prefix),
  );
  temporaryDirectories.push(base);
  return base;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("credential store", () => {
  it("partitions secrets by scope so a user identity is shared and a target identity is not", () => {
    const base = "/base";
    const context = { workspaceId: "ws", targetId: "prod" };

    expect(credentialSecretPath(base, inference, context)).toBe(
      "/base/credentials/user/central-inference.bin",
    );
    expect(credentialSecretPath(base, operational, context)).toBe(
      "/base/credentials/workspaces/ws/targets/prod/target-operational.bin",
    );
    expect(
      credentialSecretPath(base, { ...operational, scope: "workspace" }, context),
    ).toBe("/base/credentials/workspaces/ws/target-operational.bin");
  });

  it("round-trips a secret and writes it 0600", async () => {
    const base = await temporaryRoot("oc-store-");
    const store = new CredentialStore(base, fakeEncryptor());

    expect(await store.has(inference)).toBe(false);
    await store.write(inference, "super-secret");
    expect(await store.has(inference)).toBe(true);
    expect(await store.read(inference)).toBe("super-secret");

    const path = credentialSecretPath(base, inference, {});
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // The secret must not be readable as plaintext on disk.
    expect(await readFile(path, "utf8")).not.toBe("super-secret");

    await store.forget(inference);
    expect(await store.has(inference)).toBe(false);
  });

  it("refuses to store anything when OS encryption is unavailable", async () => {
    const base = await temporaryRoot("oc-store-off-");
    const store = new CredentialStore(base, fakeEncryptor(false));
    await expect(store.write(inference, "secret")).rejects.toThrow(
      CredentialStorageUnavailableError,
    );
  });

  it("treats an undecryptable secret as absent rather than crashing", async () => {
    const base = await temporaryRoot("oc-store-bad-");
    const store = new CredentialStore(base, fakeEncryptor());
    await store.write(inference, "secret");
    await writeFile(credentialSecretPath(base, inference, {}), "garbage");
    await expect(store.read(inference)).rejects.toThrow(CredentialNotStoredError);
  });

  it("requires a target before resolving a target-scoped secret", () => {
    expect(() => credentialSecretPath("/base", operational, {})).toThrow(
      /target-scoped/,
    );
  });
});

describe("capsule AWS configuration", () => {
  it("keeps the operational identity default and never names inference in the environment", () => {
    const config = buildCapsuleAwsConfig({
      helperPath: "/session/broker",
      operational,
      inference,
    });

    expect(config).toContain("[default]");
    expect(config).toContain(
      "credential_process = /session/broker target-operational",
    );
    expect(config).toContain(`[profile ${INFERENCE_PROFILE_NAME}]`);
    expect(config).toContain(
      "credential_process = /session/broker central-inference",
    );
    expect(config.indexOf("[default]")).toBeLessThan(
      config.indexOf(`[profile ${INFERENCE_PROFILE_NAME}]`),
    );
  });

  it("omits the inference profile when none is configured", () => {
    const config = buildCapsuleAwsConfig({
      helperPath: "/session/broker",
      operational,
    });
    expect(config).not.toContain(INFERENCE_PROFILE_NAME);
  });

  it("refuses to let inference reuse the operational reference", () => {
    expect(() =>
      buildCapsuleAwsConfig({
        helperPath: "/session/broker",
        operational,
        inference: { ...inference, id: operational.id },
      }),
    ).toThrow(/must not reuse/);
  });

  it("never places the session token in the generated helper or config", async () => {
    const base = await temporaryRoot("oc-helper-");
    const helperPath = join(base, "broker");
    const token = createBrokerToken();
    await writeBrokerHelper(helperPath, join(base, "broker.sock"));

    const script = await readFile(helperPath, "utf8");
    expect(script).not.toContain(token);
    expect(script).toContain("OPSCAPSULE_BROKER_TOKEN");
    expect((await stat(helperPath)).mode & 0o777).toBe(0o700);
  });
});

describe("isolation allowance", () => {
  const settingsFor = (brokerSocket?: string) =>
    buildSandboxRuntimeSettings({
      deniedReadPaths: [],
      readOnlyPaths: [],
      readWritePaths: ["/work"],
      network: { mode: "deny", allowedDomains: [] },
      userHome: "/Users/example",
      brokerSocket,
    });

  it("opens no channel at all when no credentials are brokered", () => {
    expect(settingsFor().network.allowUnixSockets).toEqual([]);
  });

  it("allows exactly one absolute socket and never widens beyond it", () => {
    const settings = settingsFor("/sessions/abc/broker.sock");
    expect(settings.network.allowUnixSockets).toEqual([
      "/sessions/abc/broker.sock",
    ]);
    expect(settings.network.allowAllUnixSockets).toBe(false);
    expect(settings.network.allowLocalBinding).toBe(false);
  });
});

describe("broker session protocol", () => {
  async function withBroker(
    run: (socketPath: string, audit: BrokerAuditEvent[]) => Promise<void>,
    overrides: { token?: string } = {},
  ) {
    const base = await temporaryRoot("oc-broker-");
    const socketPath = join(base, "broker.sock");
    const audit: BrokerAuditEvent[] = [];
    const session = new CredentialBrokerSession({
      socketPath,
      token: overrides.token ?? "session-token",
      references: [operational, inference],
      issue: async () => awsPayload,
      onAudit: (event) => audit.push(event),
    });
    await session.listen();
    try {
      await run(socketPath, audit);
    } finally {
      await session.close();
    }
  }

  function request(socketPath: string, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath, () => socket.end(payload));
      let response = "";
      socket.on("data", (chunk) => {
        response += chunk.toString();
      });
      socket.on("end", () => resolve(response));
      socket.on("error", reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error("timed out"));
      }, 5_000);
    });
  }

  it("issues credentials for an in-scope reference and audits it", async () => {
    await withBroker(async (socketPath, audit) => {
      const response = await request(
        socketPath,
        `${JSON.stringify({ token: "session-token", referenceId: "central-inference" })}\n`,
      );
      expect(JSON.parse(response)).toMatchObject({
        Version: 1,
        AccessKeyId: "ASIAFROMMAINPROCESS",
      });
      expect(audit).toEqual([
        { referenceId: "central-inference", outcome: "issued" },
      ]);
    });
  });

  it("denies a wrong token, an unknown reference, and a malformed request alike", async () => {
    await withBroker(async (socketPath, audit) => {
      for (const payload of [
        JSON.stringify({ token: "wrong", referenceId: "central-inference" }),
        JSON.stringify({ token: "session-token", referenceId: "not-declared" }),
        "{ not json",
      ]) {
        const response = await request(socketPath, `${payload}\n`);
        // Identical response in every case: a capsule must not be able to
        // enumerate which references exist by comparing error messages.
        expect(JSON.parse(response)).toEqual({
          Error: "Credential request denied.",
        });
      }
      expect(audit.every((event) => event.outcome === "denied")).toBe(true);
      // The reason is recorded for the audit trail but never sent outward.
      expect(audit.map((event) => event.reason)).toEqual([
        "invalid session token",
        "reference not in scope for this session",
        "malformed request",
      ]);
    });
  });

  it("refuses a request larger than the protocol allows", async () => {
    await withBroker(async (socketPath) => {
      // The broker destroys an oversize connection, so the client may well see
      // EPIPE mid-write. Either way the requirement is the same: no credential
      // is ever returned.
      const response = await request(
        socketPath,
        `${JSON.stringify({
          token: "session-token",
          referenceId: "central-inference",
          padding: "x".repeat(8192),
        })}\n`,
      ).catch((error: NodeJS.ErrnoException) => {
        expect(["EPIPE", "ECONNRESET"]).toContain(error.code);
        return "";
      });
      expect(response).not.toContain("ASIAFROMMAINPROCESS");
    });
  });

  it("stops issuing after revocation", async () => {
    const base = await temporaryRoot("oc-broker-revoke-");
    const socketPath = join(base, "broker.sock");
    const session = new CredentialBrokerSession({
      socketPath,
      token: "session-token",
      references: [inference],
      issue: async () => awsPayload,
    });
    await session.listen();
    session.revoke();
    const response = await request(
      socketPath,
      `${JSON.stringify({ token: "session-token", referenceId: "central-inference" })}\n`,
    );
    expect(response).not.toContain("ASIAFROMMAINPROCESS");
    await session.close();
  });

  it("removes its socket on close", async () => {
    const base = await temporaryRoot("oc-broker-close-");
    const socketPath = join(base, "broker.sock");
    const session = new CredentialBrokerSession({
      socketPath,
      token: "t",
      references: [],
      issue: async () => awsPayload,
    });
    await session.listen();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await session.close();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("payload contract", () => {
  it("satisfies AWS credential_process and Claude Code awsCredentialExport", () => {
    const payload = JSON.parse(awsDelivery.formatResponse(JSON.stringify(issued)));
    expect(payload).toMatchObject({
      Version: 1,
      AccessKeyId: "ASIAFROMMAINPROCESS",
      SecretAccessKey: "secret",
      SessionToken: "session",
      Expiration: "2026-01-01T00:00:00Z",
    });
  });

  it("omits Expiration when the issuer does not supply one", () => {
    const payload = JSON.parse(
      awsDelivery.formatResponse(
        JSON.stringify({
          accessKeyId: "a",
          secretAccessKey: "b",
          sessionToken: "c",
        }),
      ),
    );
    expect(payload.Expiration).toBeUndefined();
  });
});

describe.skipIf(!macOsSandboxAvailable)(
  "end to end inside the enforced boundary",
  () => {
    async function runCapsule(options: { allowBrokerSocket: boolean }) {
      const base = await temporaryRoot("oc-e2e-");
      const allowed = join(base, "allowed");
      await mkdir(allowed, { recursive: true });
      const socketPath = join(base, "broker.sock");
      const helperPath = join(base, "broker");

      // Real broker, real generated helper, real sandbox settings builder.
      const token = createBrokerToken();
      const session = new CredentialBrokerSession({
        socketPath,
        token,
        references: [operational, inference],
        issue: async (reference) =>
          new AwsCredentialDelivery().formatResponse(
            JSON.stringify({
              ...issued,
              accessKeyId:
                reference.id === "central-inference"
                  ? "ASIAINFERENCE"
                  : "ASIAOPERATIONAL",
            }),
          ),
      });
      await session.listen();
      await writeBrokerHelper(helperPath, socketPath);

      const settingsPath = join(base, "sandbox.json");
      await writeFile(
        settingsPath,
        JSON.stringify(
          buildSandboxRuntimeSettings({
            deniedReadPaths: [],
            readOnlyPaths: [],
            readWritePaths: [base],
            network: { mode: "deny", allowedDomains: [] },
            userHome: base,
            brokerSocket: options.allowBrokerSocket ? socketPath : undefined,
          }),
        ),
        { mode: 0o600 },
      );

      await initializeSandboxRuntime({
        backend: "sandbox-runtime",
        settingsPath,
        networkMode: "deny",
      });

      const invoke = async (referenceId: string) => {
        const launch = await wrapSandboxedLaunch(
          {
            command: helperPath,
            args: [referenceId],
            cwd: allowed,
            env: {
              ...process.env,
              OPSCAPSULE_BROKER_TOKEN: token,
            } as Record<string, string>,
          },
          `broker-${referenceId}`,
        );
        try {
          const { stdout } = await executeFile(launch.command, launch.args, {
            cwd: launch.cwd,
            env: launch.env,
            timeout: 10_000,
          });
          return { blocked: false, stdout, launch };
        } catch {
          return { blocked: true, stdout: "", launch };
        } finally {
          cleanupSandboxCommand();
        }
      };

      return { invoke, session, token, finish: async () => {
        await resetSandboxRuntime();
        await session.close();
      } };
    }

    it(
      "has no channel to the main process when no credentials are brokered",
      async () => {
        const capsule = await runCapsule({ allowBrokerSocket: false });
        try {
          expect((await capsule.invoke("central-inference")).blocked).toBe(true);
        } finally {
          await capsule.finish();
        }
      },
      30_000,
    );

    it(
      "delivers distinct operational and inference credentials minted outside the capsule",
      async () => {
        const capsule = await runCapsule({ allowBrokerSocket: true });
        try {
          const operationalResult = await capsule.invoke("target-operational");
          const inferenceResult = await capsule.invoke("central-inference");

          expect(JSON.parse(operationalResult.stdout).AccessKeyId).toBe(
            "ASIAOPERATIONAL",
          );
          expect(JSON.parse(inferenceResult.stdout).AccessKeyId).toBe(
            "ASIAINFERENCE",
          );

          // The two identities really are different inside one capsule.
          expect(JSON.parse(operationalResult.stdout).AccessKeyId).not.toBe(
            JSON.parse(inferenceResult.stdout).AccessKeyId,
          );

          // The session token is never exposed through argv.
          expect(inferenceResult.launch.args.join(" ")).not.toContain(
            capsule.token,
          );
        } finally {
          await capsule.finish();
        }
      },
      30_000,
    );

    it(
      "refuses a reference the session does not declare, from inside the capsule",
      async () => {
        const capsule = await runCapsule({ allowBrokerSocket: true });
        try {
          const result = await capsule.invoke("some-other-account");
          expect(result.stdout).not.toContain("ASIA");
        } finally {
          await capsule.finish();
        }
      },
      30_000,
    );

    it(
      "stops issuing into a live capsule the moment the session is revoked",
      async () => {
        const capsule = await runCapsule({ allowBrokerSocket: true });
        try {
          expect(
            JSON.parse((await capsule.invoke("central-inference")).stdout)
              .AccessKeyId,
          ).toBe("ASIAINFERENCE");

          capsule.session.revoke();

          const afterRevoke = await capsule.invoke("central-inference");
          expect(afterRevoke.stdout).not.toContain("ASIAINFERENCE");
        } finally {
          await capsule.finish();
        }
      },
      30_000,
    );
  },
);

describe("provider-agnostic delivery", () => {
  const registry = new CredentialDeliveryRegistry();
  const copilot: CredentialReference = {
    id: "copilot",
    name: "GitHub Copilot",
    kind: "provider-oauth",
    scope: "user",
    providerId: "opencode",
  };

  it("routes each credential kind to its own delivery adapter", () => {
    expect(registry.adapterFor("aws-profile").id).toBe("aws");
    expect(registry.adapterFor("aws-role").id).toBe("aws");
    expect(registry.adapterFor("provider-oauth").id).toBe("provider-oauth");
  });

  it("only opens a broker channel when something actually pulls", () => {
    // AWS pulls at point of use, so it needs the channel.
    expect(registry.requiresBrokerChannel([operational])).toBe(true);
    // A Copilot-only capsule is materialized at launch and needs no channel,
    // so it must not be granted a unix socket it will never use.
    expect(registry.requiresBrokerChannel([copilot])).toBe(false);
    expect(registry.requiresBrokerChannel([])).toBe(false);
    // Mixed: the AWS identity still requires it.
    expect(registry.requiresBrokerChannel([copilot, inference])).toBe(true);
  });

  it("materializes a provider login into agent state and removes it on teardown", async () => {
    const base = await temporaryRoot("oc-oauth-");
    const agentState = join(base, "agents", "opencode");
    await mkdir(agentState, { recursive: true });
    const secret = JSON.stringify({ github: { type: "oauth", access: "tok" } });

    const context = {
      targetState: join(base, "target"),
      agentState,
      assignments: [{ role: "inference" as const, reference: copilot }],
      readSecret: async () => secret,
    };

    await new ProviderOAuthDelivery().prepare(context);
    const destination = join(agentState, "data", "opencode", "auth.json");
    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({
      github: { type: "oauth", access: "tok" },
    });
    expect((await stat(destination)).mode & 0o777).toBe(0o600);

    // The secret must not outlive the capsule.
    await new ProviderOAuthDelivery().teardown(context);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never lets a refresh token into the capsule", () => {
    const stored = JSON.stringify({
      "github-copilot": {
        type: "oauth",
        access: "short-lived",
        refresh: "long-lived-must-not-leak",
        expires: 1,
      },
    });
    const materialized = withoutRefreshTokens(stored);

    expect(materialized).toContain("short-lived");
    // A refresh token would let a capsule mint new access tokens indefinitely,
    // outliving the session and defeating revocation.
    expect(materialized).not.toContain("long-lived-must-not-leak");
    expect(JSON.parse(materialized)["github-copilot"].refresh).toBeUndefined();
    expect(JSON.parse(materialized)["github-copilot"].expires).toBe(1);
  });

  it("passes through a non-JSON credential rather than corrupting it", () => {
    expect(withoutRefreshTokens("ghp_opaque_token")).toBe("ghp_opaque_token");
  });

  it("refuses to serve a materialized credential over the broker channel", () => {
    // A provider login has no credential_process contract, so asking the
    // broker for one is a programming error rather than a silent fallback.
    expect(() => registry.formatResponse(copilot, "{}")).toThrow(
      /not served over the broker channel/,
    );
  });

  it("refuses a provider it has no delivery implementation for", async () => {
    const base = await temporaryRoot("oc-oauth-unknown-");
    await expect(
      new ProviderOAuthDelivery().prepare({
        targetState: base,
        agentState: base,
        assignments: [
          {
            role: "inference",
            reference: { ...copilot, providerId: "some-future-agent" },
          },
        ],
        readSecret: async () => "{}",
      }),
    ).rejects.toThrow(/No credential delivery is implemented/);
  });
});

describe("credential service", () => {
  const manifest = {
    metadata: { id: "atlas", name: "Atlas" },
    credentials: [
      { id: "central-inference", name: "Copilot", kind: "provider-oauth", scope: "user", providerId: "opencode" },
      { id: "target-operational", name: "Production", kind: "aws-profile", scope: "target", region: "eu-west-1" },
    ],
    inferenceCredential: "central-inference",
    targets: [
      { id: "production", operationalCredential: "target-operational" },
      { id: "staging" },
    ],
  } as unknown as Parameters<typeof credentialStatuses>[1];

  it("resolves a target-scoped reference to the target that selects it", () => {
    expect(
      storageContextFor(manifest, manifest.credentials[1]!),
    ).toEqual({ workspaceId: "atlas", targetId: "production" });
    // An explicit target always wins.
    expect(
      storageContextFor(manifest, manifest.credentials[1]!, "staging").targetId,
    ).toBe("staging");
  });

  it("reports authentication status without exposing any secret", async () => {
    const base = await temporaryRoot("oc-service-");
    const store = new CredentialStore(base, fakeEncryptor());
    await store.write(manifest.credentials[0]!, "super-secret", {});

    const statuses = await credentialStatuses(store, manifest);
    expect(statuses).toEqual([
      {
        id: "central-inference",
        name: "Copilot",
        kind: "provider-oauth",
        scope: "user",
        authenticated: true,
      },
      {
        id: "target-operational",
        name: "Production",
        kind: "aws-profile",
        scope: "target",
        authenticated: false,
      },
    ]);
    // The renderer contract must never carry credential material.
    expect(JSON.stringify(statuses)).not.toContain("super-secret");
  });

  it("rejects a credential the workspace does not declare", () => {
    expect(() => requireReference(manifest, "not-declared")).toThrow(
      /does not declare credential/,
    );
  });

  it("validates a secret at import time rather than inside a capsule", () => {
    const aws = manifest.credentials[1]!;
    expect(() => assertUsableSecret(aws, "")).toThrow(/empty/);
    expect(() => assertUsableSecret(aws, "not json")).toThrow(/valid JSON/);
    expect(() =>
      assertUsableSecret(aws, JSON.stringify({ accessKeyId: "a" })),
    ).toThrow(/secretAccessKey/);
    expect(() =>
      assertUsableSecret(aws, JSON.stringify(issued)),
    ).not.toThrow();

    const oauth = manifest.credentials[0]!;
    expect(() => assertUsableSecret(oauth, "not json")).toThrow(/valid JSON/);
    expect(() => assertUsableSecret(oauth, "{}")).not.toThrow();
  });
});

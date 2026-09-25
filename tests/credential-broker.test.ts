import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertUsableSocketPath,
  BROKER_REFERENCE_HEADER,
  BROKER_TOKEN_HEADER,
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
  applyInferenceConfiguration,
  inferenceEnvironment,
} from "../src/main/credentials/inference-configuration.js";
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
  discoverAgentLogins,
  readAgentLogin,
} from "../src/main/credentials/agent-logins.js";
import {
  AwsProfileError,
  exportProfileCredentials,
  profileResolves,
} from "../src/main/credentials/aws-profile.js";
import { createCredentialIssuer } from "../src/main/credentials/issuer.js";
import {
  assertUsableSecret,
  credentialOverview,
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

describe("AWS config assembly", () => {
  it("appends brokered profiles instead of replacing the target's own", async () => {
    const base = await temporaryRoot("oc-aws-append-");
    const awsDir = join(base, ".aws");
    await mkdir(awsDir, { recursive: true });
    // The target's imported cloud profile, staged before delivery runs.
    await writeFile(
      join(awsDir, "config"),
      "[profile ri-obs-use1-dev]\nregion = us-east-1\nsso_start_url = https://example\n",
    );

    await new AwsCredentialDelivery().prepare({
      helperPath: "/session/broker",
      targetState: base,
      agentState: join(base, "agents"),
      assignments: [{ role: "inference", reference: inference }],
      readSecret: async () => "",
    });

    const written = await readFile(join(awsDir, "config"), "utf8");
    // Overwriting here removed the profile AWS_PROFILE names, leaving the
    // capsule unable to load any credentials at all.
    expect(written).toContain("[profile ri-obs-use1-dev]");
    expect(written).toContain("sso_start_url = https://example");
    expect(written).toContain("[profile opscapsule-inference]");
  });

  it("creates the aws directory when the target has no cloud connection", async () => {
    const base = await temporaryRoot("oc-aws-nocloud-");
    await new AwsCredentialDelivery().prepare({
      helperPath: "/session/broker",
      targetState: base,
      agentState: join(base, "agents"),
      assignments: [{ role: "operational", reference: operational }],
      readSecret: async () => "",
    });
    expect(await readFile(join(base, ".aws", "config"), "utf8")).toContain(
      "[default]",
    );
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

  function request(
    socketPath: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const call = httpRequest(
        { socketPath, path: "/credentials", method: "GET", headers },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk.toString();
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body }),
          );
        },
      );
      call.on("error", reject);
      call.end();
    });
  }

  const headersFor = (token: string, reference: string) => ({
    [BROKER_TOKEN_HEADER]: token,
    [BROKER_REFERENCE_HEADER]: reference,
  });

  it("issues credentials for an in-scope reference and audits it", async () => {
    await withBroker(async (socketPath, audit) => {
      const response = await request(
        socketPath,
        headersFor("session-token", "central-inference"),
      );
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        Version: 1,
        AccessKeyId: "ASIAFROMMAINPROCESS",
      });
      expect(audit).toEqual([
        { referenceId: "central-inference", outcome: "issued" },
      ]);
    });
  });

  it("waits for a slow issuer instead of dropping the response", async () => {
    // The original nc transport exited on stdin EOF and discarded anything
    // that had not already arrived, so every real AWS resolution was lost.
    const base = await temporaryRoot("oc-broker-slow-");
    const socketPath = join(base, "broker.sock");
    const session = new CredentialBrokerSession({
      socketPath,
      token: "session-token",
      references: [inference],
      issue: async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return awsPayload;
      },
    });
    await session.listen();
    try {
      const response = await request(
        socketPath,
        headersFor("session-token", "central-inference"),
      );
      expect(JSON.parse(response.body).AccessKeyId).toBe("ASIAFROMMAINPROCESS");
    } finally {
      await session.close();
    }
  });

  it("denies a wrong token, an unknown reference, and a malformed one alike", async () => {
    await withBroker(async (socketPath, audit) => {
      for (const headers of [
        headersFor("wrong", "central-inference"),
        headersFor("session-token", "not-declared"),
        headersFor("session-token", "Not A Reference"),
      ]) {
        const response = await request(socketPath, headers);
        // Identical response in every case: a capsule must not be able to
        // enumerate which references exist by comparing error messages.
        expect(response.status).toBe(403);
        expect(JSON.parse(response.body)).toEqual({
          Error: "Credential request denied.",
        });
      }
      expect(audit.every((event) => event.outcome === "denied")).toBe(true);
      // The reason is recorded for the audit trail but never sent outward.
      expect(audit.map((event) => event.reason)).toEqual([
        "invalid session token",
        "reference not in scope for this session",
        "malformed credential reference",
      ]);
    });
  });

  it("ignores anything the capsule puts in the request body", async () => {
    await withBroker(async (socketPath) => {
      // The capsule may name a reference and nothing else; no body it sends is
      // ever read, so it cannot influence what the broker does.
      const response = await request(socketPath, {
        ...headersFor("session-token", "central-inference"),
        "content-length": "0",
      });
      expect(response.status).toBe(200);
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
      headersFor("session-token", "central-inference"),
    );
    expect(response.body).not.toContain("ASIAFROMMAINPROCESS");
    await session.close();
  });

  it("rejects a socket path longer than the platform allows", async () => {
    // The real userData path, which is what actually failed with EINVAL.
    const realistic =
      "/Users/example/Library/Application Support/OpsCapsule/sessions/9edb24db-51a0-4989-9528-108cfb2d7813/broker.sock";
    expect(() => assertUsableSocketPath(realistic)).toThrow(/over the 10\d-byte limit/);
    expect(() =>
      assertUsableSocketPath("/private/tmp/opscapsule-9edb24db-AbCdEf/broker.sock"),
    ).not.toThrow();
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
        issue: async (reference) => {
          // Resolving a real AWS profile takes hundreds of milliseconds. The
          // original nc transport dropped any response that was not already
          // waiting, so the delay is part of what must be proven at the
          // boundary, not just in isolation.
          await new Promise((resolve) => setTimeout(resolve, 600));
          return new AwsCredentialDelivery().formatResponse(
            JSON.stringify({
              ...issued,
              accessKeyId:
                reference.id === "central-inference"
                  ? "ASIAINFERENCE"
                  : "ASIAOPERATIONAL",
            }),
          );
        },
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

  it("keeps the refresh token for a provider that cannot work without it", async () => {
    const base = await temporaryRoot("oc-oauth-copilot-");
    const agentState = join(base, "agents", "opencode");
    await mkdir(agentState, { recursive: true });
    // OpenCode stores a Copilot login with expires: 0, meaning it mints a
    // fresh Copilot API token from the refresh token on first use. Stripping
    // it would deliver a credential that fails immediately.
    const secret = JSON.stringify({
      "github-copilot": {
        type: "oauth",
        access: "gho_access",
        refresh: "ghu_refresh",
        expires: 0,
      },
    });

    await new ProviderOAuthDelivery().prepare({
      targetState: join(base, "target"),
      agentState,
      assignments: [{ role: "inference", reference: copilot }],
      readSecret: async () => secret,
    });

    const written = JSON.parse(
      await readFile(join(agentState, "data", "opencode", "auth.json"), "utf8"),
    );
    expect(written["github-copilot"].refresh).toBe("ghu_refresh");
    expect(written["github-copilot"].expires).toBe(0);
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
    expect(statuses).toMatchObject([
      {
        id: "central-inference",
        kind: "provider-oauth",
        scope: "user",
        authenticated: true,
      },
      {
        id: "target-operational",
        kind: "aws-profile",
        scope: "target",
        authenticated: false,
      },
    ]);
    // An AWS credential naming no profile must say so rather than look merely
    // unauthenticated, which would suggest importing something.
    expect(statuses[1]!.detail).toMatch(/No profile selected/);
    // The renderer contract must never carry credential material.
    expect(JSON.stringify(statuses)).not.toContain("super-secret");
  });

  it("tells the user to save when a credential is only in an unsaved draft", () => {
    // The saved manifest is the authority, so the renderer cannot make main
    // act on a reference it invented. The message has to say so usefully.
    expect(() => requireReference(manifest, "not-declared")).toThrow(
      /is not saved in workspace 'atlas'. Save the workspace and try again./,
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

describe("AWS profile credentials", () => {
  it(
    "fails closed for a profile that cannot produce credentials",
    async () => {
      // Environment-independent: whether the AWS CLI is absent or the profile
      // is unknown, the result must be a clear refusal rather than a
      // credential. Instance metadata is disabled for this call, so an unknown
      // profile fails promptly instead of stalling on a metadata lookup.
      await expect(
        exportProfileCredentials("opscapsule-does-not-exist"),
      ).rejects.toBeInstanceOf(AwsProfileError);
      expect(await profileResolves("opscapsule-does-not-exist")).toBe(false);
    },
    20_000,
  );

  it("refuses an aws-profile reference that names no profile", async () => {
    const issue = createCredentialIssuer(
      new CredentialStore("/unused", fakeEncryptor()),
      { workspaceId: "ws", targetId: "t" },
    );
    await expect(
      issue({
        id: "no-profile",
        name: "No profile",
        kind: "aws-profile",
        scope: "user",
      }),
    ).rejects.toThrow(/does not name an AWS profile/);
  });

  it("treats a static profile without a session token as valid", () => {
    // Long-lived IAM user credentials have no SessionToken; rejecting them
    // would make perfectly normal profiles look broken.
    const payload = JSON.parse(
      awsDelivery.formatResponse(
        JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "s" }),
      ),
    );
    expect(payload).toEqual({
      Version: 1,
      AccessKeyId: "AKIA",
      SecretAccessKey: "s",
    });
  });
});

describe("inference configuration is written by the app", () => {
  const awsInference = { ...inference, region: "us-east-1" };

  it("selects the inference profile for OpenCode without the user editing anything", async () => {
    const base = await temporaryRoot("oc-infer-opencode-");
    await applyInferenceConfiguration({
      home: base,
      agentState: join(base, "agents"),
      adapter: "opencode",
      reference: awsInference,
    });

    const config = JSON.parse(
      await readFile(join(base, ".config", "opencode", "opencode.json"), "utf8"),
    );
    // Without this OpenCode falls back to AWS_PROFILE and bills inference to
    // the customer's operational account.
    expect(config.provider["amazon-bedrock"].options).toEqual({
      profile: "opscapsule-inference",
      region: "us-east-1",
    });
  });

  it("merges into imported managed configuration instead of replacing it", async () => {
    const base = await temporaryRoot("oc-infer-merge-");
    const path = join(base, ".config", "opencode", "opencode.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        model: "anthropic/claude-sonnet-4",
        provider: { "amazon-bedrock": { options: { region: "eu-west-1" } } },
      }),
    );

    await applyInferenceConfiguration({
      home: base,
      agentState: join(base, "agents"),
      adapter: "opencode",
      reference: awsInference,
    });

    const config = JSON.parse(await readFile(path, "utf8"));
    expect(config.model).toBe("anthropic/claude-sonnet-4");
    expect(config.provider["amazon-bedrock"].options.profile).toBe(
      "opscapsule-inference",
    );
    // The credential's region wins, because it describes where that identity
    // can actually invoke Bedrock.
    expect(config.provider["amazon-bedrock"].options.region).toBe("us-east-1");
  });

  it("repoints a host profile pinned in imported configuration", async () => {
    const base = await temporaryRoot("oc-infer-stale-");
    const path = join(base, ".config", "opencode", "opencode.json");
    await mkdir(dirname(path), { recursive: true });
    // Imported config commonly pins a profile that exists on the host but not
    // inside the capsule, and OpenCode has been seen using the underscore
    // spelling. Leaving either in place leaves the agent unresolvable.
    await writeFile(
      path,
      JSON.stringify({
        provider: {
          amazon_bedrock: { options: { profile: "claude-code", region: "us-east-1" } },
        },
      }),
    );

    await applyInferenceConfiguration({
      home: base,
      agentState: join(base, "agents"),
      adapter: "opencode",
      reference: awsInference,
    });

    const config = JSON.parse(await readFile(path, "utf8"));
    expect(config.provider.amazon_bedrock.options.profile).toBe(
      "opscapsule-inference",
    );
    expect(config.provider["amazon-bedrock"].options.profile).toBe(
      "opscapsule-inference",
    );
    expect(JSON.stringify(config)).not.toContain("claude-code");
  });

  it("points Claude Code at the broker, which has no profile option", async () => {
    const base = await temporaryRoot("oc-infer-claude-");
    await applyInferenceConfiguration({
      home: base,
      agentState: join(base, "agents"),
      adapter: "claude-code",
      reference: awsInference,
      helperPath: "/session/broker",
    });

    const settings = JSON.parse(
      await readFile(
        join(base, "agents", "data", "claude", "settings.json"),
        "utf8",
      ),
    );
    expect(settings.awsCredentialExport).toBe(
      "/session/broker central-inference",
    );
    expect(settings.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });

  it("writes nothing when a provider login needs no configuration", async () => {
    const base = await temporaryRoot("oc-infer-oauth-");
    await applyInferenceConfiguration({
      home: base,
      agentState: join(base, "agents"),
      adapter: "opencode",
      // No model, and no imported Bedrock pin to clear: there is nothing to
      // configure, so the capsule must not be handed a file it never needed.
      reference: {
        id: "copilot",
        name: "Copilot",
        kind: "provider-oauth",
        scope: "user",
        providerId: "opencode",
      },
    });
    await expect(
      readFile(join(base, ".config", "opencode", "opencode.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never exposes a credential-minting command to the shell panes", () => {
    const environment = inferenceEnvironment(awsInference);
    expect(environment.OPSCAPSULE_INFERENCE_PROFILE).toBe(
      "opscapsule-inference",
    );
    expect(JSON.stringify(environment)).not.toContain("broker");
    expect(JSON.stringify(environment)).not.toContain(awsInference.id);
  });
});

describe("agent login discovery", () => {
  it("lists logins without returning any token value", async () => {
    const logins = await discoverAgentLogins();
    // Discovery is best effort: a host with no agent store simply offers
    // nothing. What matters is that no secret is ever carried.
    for (const login of logins) {
      expect(Object.keys(login).sort()).toEqual([
        "id",
        "provider",
        "providerLabel",
        "type",
      ]);
    }
    expect(JSON.stringify(logins)).not.toMatch(/gho_|ghu_|sk-/);
  });

  it("refuses a provider it does not know", async () => {
    await expect(readAgentLogin("not-an-agent", "github-copilot")).rejects.toThrow(
      /No credential store is known/,
    );
  });
});

describe("switching the inference identity away from AWS", () => {
  const copilotInference = {
    id: "copilot",
    name: "GitHub Copilot",
    kind: "provider-oauth" as const,
    scope: "user" as const,
    providerId: "opencode",
    sourceProfile: "github-copilot",
    model: "github-copilot/gpt-5",
  };

  it("clears a Bedrock profile that imported configuration still pins", async () => {
    const base = await temporaryRoot("oc-switch-");
    const path = join(base, ".config", "opencode", "opencode.json");
    await mkdir(dirname(path), { recursive: true });
    // Exactly what a real imported profile looks like: a Bedrock provider
    // pinned to a host profile that does not exist inside the capsule.
    await writeFile(
      path,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          amazon_bedrock: { options: { region: "us-east-1", profile: "claude-code" } },
        },
        plugin: ["opencode-add-dir"],
      }),
    );

    await applyInferenceConfiguration({
      home: base,
      agentState: join(base, "agents"),
      adapter: "opencode",
      reference: copilotInference,
    });

    const config = JSON.parse(await readFile(path, "utf8"));
    // The agent must not be left selecting a provider it cannot authenticate.
    expect(JSON.stringify(config)).not.toContain("claude-code");
    // A Bedrock provider the capsule cannot authenticate must not be left
    // configured, or the agent starts on a provider it cannot use.
    expect(config.provider?.amazon_bedrock).toBeUndefined();
    // An emptied provider block is removed rather than left behind.
    expect(config.provider).toBeUndefined();
    // The identity says which model to use, so no manual step remains.
    expect(config.model).toBe("github-copilot/gpt-5");
    // Unrelated configuration is preserved.
    expect(config.plugin).toEqual(["opencode-add-dir"]);
    expect(config.$schema).toBe("https://opencode.ai/config.json");
  });

  it("sets the model for an AWS identity too", async () => {
    const base = await temporaryRoot("oc-switch-aws-");
    await applyInferenceConfiguration({
      home: base,
      agentState: join(base, "agents"),
      adapter: "opencode",
      reference: { ...inference, model: "amazon-bedrock/claude-sonnet-4" },
    });
    const config = JSON.parse(
      await readFile(join(base, ".config", "opencode", "opencode.json"), "utf8"),
    );
    expect(config.model).toBe("amazon-bedrock/claude-sonnet-4");
    expect(config.provider["amazon-bedrock"].options.profile).toBe(
      "opscapsule-inference",
    );
  });
});

describe("credential overview grouping", () => {
  const workspaceA = {
    metadata: { id: "atlas", name: "Atlas" },
    credentials: [
      { id: "copilot", name: "Copilot", kind: "provider-oauth", scope: "user", providerId: "opencode" },
      { id: "shared", name: "Shared", kind: "provider-oauth", scope: "workspace", providerId: "opencode" },
      { id: "prod-ops", name: "Prod ops", kind: "aws-profile", scope: "target" },
      { id: "stage-ops", name: "Stage ops", kind: "aws-profile", scope: "target" },
    ],
    targets: [
      { id: "production", operationalCredential: "prod-ops" },
      { id: "staging", operationalCredential: "stage-ops" },
    ],
  } as unknown as Parameters<typeof credentialStatuses>[1];

  const workspaceB = {
    metadata: { id: "borealis", name: "Borealis" },
    credentials: [
      { id: "copilot", name: "Copilot", kind: "provider-oauth", scope: "user", providerId: "opencode" },
      { id: "other", name: "Other", kind: "provider-oauth", scope: "workspace", providerId: "opencode" },
    ],
    targets: [],
  } as unknown as Parameters<typeof credentialStatuses>[1];

  const store = () => new CredentialStore("/unused", fakeEncryptor());

  it("keeps user credentials regardless of selection and lists them once", async () => {
    const overview = await credentialOverview(store(), [workspaceA, workspaceB], {
      workspaceId: "atlas",
      targetId: "production",
    });
    // Declared by both workspaces, but one stored secret, so one entry.
    expect(overview.user.map((entry) => entry.id)).toEqual(["copilot"]);
  });

  it("swaps workspace credentials when the selection changes", async () => {
    const onAtlas = await credentialOverview(store(), [workspaceA, workspaceB], {
      workspaceId: "atlas",
    });
    const onBorealis = await credentialOverview(store(), [workspaceA, workspaceB], {
      workspaceId: "borealis",
    });
    expect(onAtlas.workspace.map((entry) => entry.id)).toEqual(["shared"]);
    expect(onBorealis.workspace.map((entry) => entry.id)).toEqual(["other"]);
    // User credentials are unaffected by the switch.
    expect(onBorealis.user.map((entry) => entry.id)).toEqual(["copilot"]);
  });

  it("shows only the selected target's own credential", async () => {
    const overview = await credentialOverview(store(), [workspaceA], {
      workspaceId: "atlas",
      targetId: "staging",
    });
    expect(overview.target.map((entry) => entry.id)).toEqual(["stage-ops"]);
  });

  it("shows user credentials before anything is selected", async () => {
    const overview = await credentialOverview(store(), [workspaceA, workspaceB], {});
    expect(overview.user.map((entry) => entry.id)).toEqual(["copilot"]);
    expect(overview.workspace).toEqual([]);
    expect(overview.target).toEqual([]);
  });
});

describe("acting on a user credential from another workspace", () => {
  it("reports the declaring workspace, not the selected one", async () => {
    const declaring = {
      metadata: { id: "ri-observability", name: "RI" },
      credentials: [
        { id: "copilot", name: "Copilot", kind: "provider-oauth", scope: "user", providerId: "opencode" },
      ],
      targets: [],
    } as unknown as Parameters<typeof credentialStatuses>[1];
    const other = {
      metadata: { id: "borealis", name: "Borealis" },
      credentials: [],
      targets: [],
    } as unknown as Parameters<typeof credentialStatuses>[1];

    // Selection is a workspace that does not declare it.
    const overview = await credentialOverview(
      new CredentialStore("/unused", fakeEncryptor()),
      [declaring, other],
      { workspaceId: "borealis" },
    );

    // Without this the action resolves against the selected workspace and
    // fails with "not saved in workspace borealis".
    expect(overview.user[0]!.workspaceId).toBe("ri-observability");
  });
});

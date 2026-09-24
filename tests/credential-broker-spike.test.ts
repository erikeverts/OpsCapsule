import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, afterEach } from "vitest";
import {
  BrokerAuthorityError,
  createSessionBrokerAuthority,
  formatBrokeredCredentials,
  handleBrokerRequest,
  readBrokerRequest,
} from "../src/main/credentials/broker-helper.js";
import {
  buildCapsuleAwsConfig,
  buildCapsuleAwsEnvironment,
  INFERENCE_PROFILE_NAME,
} from "../src/main/credentials/capsule-aws-config.js";
import { inspectAgentConfigurationFile } from "../src/main/local-resources.js";
import {
  cleanupSandboxCommand,
  initializeSandboxRuntime,
  resetSandboxRuntime,
  wrapSandboxedLaunch,
} from "../src/main/isolation/sandbox-command.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

// Must stay aligned with checkSandboxRuntimeAvailability.
const macOsSandboxAvailable =
  process.platform === "darwin" &&
  spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)\n(allow default)", "/usr/bin/true"],
    { stdio: "ignore" },
  ).status === 0 &&
  spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

const credentials = {
  accessKeyId: "ASIAEXAMPLE",
  secretAccessKey: "secret-example",
  sessionToken: "session-example",
  expiration: "2026-01-01T00:00:00Z",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("credential broker helper contract", () => {
  it("emits one payload that both AWS and Claude Code accept", () => {
    const payload = JSON.parse(formatBrokeredCredentials(credentials));

    // AWS credential_process requires Version 1 with top-level keys.
    expect(payload).toMatchObject({
      Version: 1,
      AccessKeyId: "ASIAEXAMPLE",
      SecretAccessKey: "secret-example",
      SessionToken: "session-example",
      Expiration: "2026-01-01T00:00:00Z",
    });

    // Claude Code's awsCredentialExport accepts the same flat shape, so a
    // single helper serves both consumers with no branching.
    expect(Object.keys(payload).sort()).toEqual([
      "AccessKeyId",
      "Expiration",
      "SecretAccessKey",
      "SessionToken",
      "Version",
    ]);
  });

  it("takes its request from the environment, never from argv", () => {
    expect(
      readBrokerRequest({
        OPSCAPSULE_BROKER_TOKEN: "token",
        OPSCAPSULE_BROKER_REFERENCE: "inference",
      }),
    ).toEqual({ token: "token", referenceId: "inference" });

    expect(() => readBrokerRequest({})).toThrow(BrokerAuthorityError);
  });

  it("fails closed on a wrong token, an out-of-scope reference, and revocation", async () => {
    const authority = createSessionBrokerAuthority("session-token", [
      "operational",
    ]);
    const resolve = async () => credentials;

    await expect(
      handleBrokerRequest(
        { token: "wrong", referenceId: "operational" },
        authority,
        resolve,
      ),
    ).rejects.toThrow(BrokerAuthorityError);

    // A capsule cannot reach a reference its target does not use.
    await expect(
      handleBrokerRequest(
        { token: "session-token", referenceId: "inference" },
        authority,
        resolve,
      ),
    ).rejects.toThrow(/not in scope/);

    await expect(
      handleBrokerRequest(
        { token: "session-token", referenceId: "operational" },
        authority,
        resolve,
      ),
    ).resolves.toContain("ASIAEXAMPLE");

    authority.revoke();
    await expect(
      handleBrokerRequest(
        { token: "session-token", referenceId: "operational" },
        authority,
        resolve,
      ),
    ).rejects.toThrow(/revoked/);
  });
});

describe("two-identity capsule AWS configuration", () => {
  const input = {
    helperCommand: "/opt/opscapsule/broker",
    operational: { referenceId: "target-operational", region: "eu-west-1" },
    inference: { referenceId: "central-inference", region: "us-east-1" },
  };

  it("keeps the operational identity default and never names inference in the environment", () => {
    const config = buildCapsuleAwsConfig(input);

    expect(config).toContain("[default]");
    expect(config).toContain(
      "credential_process = /opt/opscapsule/broker --reference target-operational",
    );
    expect(config).toContain(`[profile ${INFERENCE_PROFILE_NAME}]`);
    expect(config).toContain(
      "credential_process = /opt/opscapsule/broker --reference central-inference",
    );

    // The inference profile exists but is not the default profile.
    expect(config.indexOf("[default]")).toBeLessThan(
      config.indexOf(`[profile ${INFERENCE_PROFILE_NAME}]`),
    );

    // The decisive invariant: nothing in the environment points at inference,
    // so operational commands the agent spawns cannot inherit it.
    const environment = buildCapsuleAwsEnvironment(input);
    expect(environment.AWS_PROFILE).toBe("default");
    expect(JSON.stringify(environment)).not.toContain("central-inference");
    expect(JSON.stringify(environment)).not.toContain(INFERENCE_PROFILE_NAME);
  });

  it("omits the inference profile entirely when none is configured", () => {
    const config = buildCapsuleAwsConfig({
      helperCommand: input.helperCommand,
      operational: input.operational,
    });
    expect(config).not.toContain(INFERENCE_PROFILE_NAME);
  });

  it("refuses to let inference reuse the operational credential reference", () => {
    expect(() =>
      buildCapsuleAwsConfig({
        helperCommand: input.helperCommand,
        operational: input.operational,
        inference: { referenceId: "target-operational", region: "us-east-1" },
      }),
    ).toThrow(/must not reuse/);
  });
});

describe("agent configuration cannot smuggle an AWS identity", () => {
  it("flags AWS_PROFILE hidden in a Claude Code settings env block", async () => {
    const base = await mkdtemp(join("/tmp", "oc-broker-inspect-"));
    temporaryDirectories.push(base);
    const settings = join(base, "settings.json");

    // The manifest schema blocks AWS_* in profile.environment, but a managed
    // settings.json has its own env block and .claude/settings.json is an
    // allowed managed destination. This is the bypass that needed proving.
    await writeFile(
      settings,
      JSON.stringify({ env: { AWS_PROFILE: "some-other-account" } }),
    );

    const inspection = await inspectAgentConfigurationFile(settings);
    expect(
      inspection.warnings.some(
        (warning) =>
          warning.category === "identity" && warning.severity === "danger",
      ),
    ).toBe(true);
  });

  it("does not flag the legitimate OpenCode Bedrock profile selection", async () => {
    const base = await mkdtemp(join("/tmp", "oc-broker-inspect-ok-"));
    temporaryDirectories.push(base);
    const config = join(base, "opencode.json");

    // Inference selection by profile name must remain possible, so this must
    // not trip the identity guard that blocks launch.
    await writeFile(
      config,
      JSON.stringify({
        provider: {
          "amazon-bedrock": {
            options: { region: "us-east-1", profile: INFERENCE_PROFILE_NAME },
          },
        },
      }),
    );

    const inspection = await inspectAgentConfigurationFile(config);
    expect(
      inspection.warnings.some((warning) => warning.category === "identity"),
    ).toBe(false);
  });
});

describe.skipIf(!macOsSandboxAvailable)(
  "broker helper reaches the main process from inside the capsule",
  () => {
    /**
     * Runs the real broker topology: the credential-holding authority lives in
     * this (unsandboxed) process and is reachable only over a unix socket; the
     * helper inside the capsule is a thin client carrying no secret.
     *
     * `allowOwnSocket` selects whether the capsule is permitted to reach the
     * socket that belongs to its own session.
     */
    async function probeBroker(allowOwnSocket: boolean) {
      const base = await mkdtemp(join("/private/tmp", "oc-broker-"));
      temporaryDirectories.push(base);
      const allowed = join(base, "allowed");
      await mkdir(allowed, { recursive: true });
      const socketPath = join(allowed, "broker.sock");

      // Main process: holds the secret, authenticates, mints a session.
      const authority = createSessionBrokerAuthority("session-token", [
        "central-inference",
      ]);
      const server = createServer((socket) => {
        socket.once("data", (chunk) => {
          void (async () => {
            try {
              socket.end(
                await handleBrokerRequest(
                  JSON.parse(chunk.toString()),
                  authority,
                  async () => ({
                    ...credentials,
                    accessKeyId: "ASIAFROMMAINPROCESS",
                  }),
                ),
              );
            } catch (error) {
              socket.end(`ERROR ${(error as Error).message}`);
            }
          })();
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));

      const settingsPath = join(base, "sandbox.json");
      await writeFile(
        settingsPath,
        JSON.stringify({
          network: {
            allowedDomains: [],
            deniedDomains: ["*"],
            strictAllowlist: true,
            // Only an absolute path is honoured here; glob patterns such as
            // "**/broker.sock" are not, which forces the narrowest allowance.
            allowUnixSockets: allowOwnSocket ? [socketPath] : [],
            allowAllUnixSockets: false,
            allowLocalBinding: false,
          },
          filesystem: {
            denyRead: [],
            allowRead: [allowed],
            allowWrite: [allowed],
            denyWrite: [],
          },
          enableWeakerNestedSandbox: false,
          enableWeakerNetworkIsolation: false,
          allowAppleEvents: false,
          allowPty: true,
        }),
      );

      // The helper relays the session request and holds no credential itself.
      const helper = join(allowed, "broker");
      await writeFile(
        helper,
        [
          "#!/bin/sh",
          'if [ -z "$OPSCAPSULE_BROKER_TOKEN" ]; then exit 64; fi',
          "printf '{\"token\":\"%s\",\"referenceId\":\"%s\"}'" +
            ' "$OPSCAPSULE_BROKER_TOKEN" "$OPSCAPSULE_BROKER_REFERENCE"' +
            ` | /usr/bin/nc -U "${socketPath}"`,
          "",
        ].join("\n"),
      );
      await chmod(helper, 0o700);

      await initializeSandboxRuntime({
        backend: "sandbox-runtime",
        settingsPath,
        networkMode: "deny",
      });
      const launch = await wrapSandboxedLaunch(
        {
          command: "/bin/sh",
          args: ["-c", '"$1"', "child", helper],
          cwd: allowed,
          env: {
            ...process.env,
            OPSCAPSULE_BROKER_TOKEN: "session-token",
            OPSCAPSULE_BROKER_REFERENCE: "central-inference",
          } as Record<string, string>,
        },
        "broker-helper",
      );

      let stdout = "";
      let blocked = false;
      try {
        const result = await executeFile(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.env,
          timeout: 10_000,
        });
        stdout = result.stdout;
      } catch {
        blocked = true;
      }
      cleanupSandboxCommand();
      await resetSandboxRuntime();
      server.close();
      return { blocked, stdout, launch };
    }

    it(
      "is blocked by the isolation settings OpsCapsule ships today",
      async () => {
        // Current production config sets allowUnixSockets to []. A broker that
        // authenticates outside the sandbox is therefore impossible to build
        // without an explicit, narrow allowance being added first.
        const { blocked } = await probeBroker(false);
        expect(blocked).toBe(true);
      },
      20_000,
    );

    it(
      "succeeds with only its own session socket allowed",
      async () => {
        const { blocked, stdout, launch } = await probeBroker(true);
        expect(blocked).toBe(false);

        const payload = JSON.parse(stdout);
        expect(payload.Version).toBe(1);
        // Proves the credential was minted in the main process and delivered
        // into the capsule, rather than ever being stored inside it.
        expect(payload.AccessKeyId).toBe("ASIAFROMMAINPROCESS");

        // The session token must not be readable via `ps` by the agent or the
        // shell panes sharing the capsule.
        expect(launch.args.join(" ")).not.toContain("session-token");
      },
      20_000,
    );
  },
);

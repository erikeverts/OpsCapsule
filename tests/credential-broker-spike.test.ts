import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { SandboxRuntimeIsolationBackend } from "../src/main/isolation/sandbox-runtime.js";
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
  "broker helper execution inside the capsule boundary",
  () => {
    it(
      "spawns as a child of a sandboxed process and returns credentials without reading stdin",
      async () => {
        const base = await mkdtemp(join("/private/tmp", "oc-broker-"));
        temporaryDirectories.push(base);
        const allowed = join(base, "allowed");
        const root = join(base, "runtime");
        const home = join(root, "home");
        const sessionTemp = join(root, "tmp");
        await Promise.all(
          [allowed, home, sessionTemp, join(base, "target-state")].map((path) =>
            mkdir(path, { recursive: true }),
          ),
        );

        // Stand-in for the broker helper. The real helper is an OpsCapsule
        // executable; what is under test here is whether the sandbox permits
        // an AWS client to spawn it at all and read its stdout.
        const helper = join(allowed, "broker");
        await writeFile(
          helper,
          [
            "#!/bin/sh",
            'if [ -z "$OPSCAPSULE_BROKER_TOKEN" ]; then exit 1; fi',
            `printf '%s' '${formatBrokeredCredentials(credentials).trim()}'`,
            "",
          ].join("\n"),
        );
        await chmod(helper, 0o700);

        const runtime = {
          root,
          home,
          temp: sessionTemp,
          kubeconfig: join(root, "kubeconfig.yaml"),
          sandboxConfig: join(root, "sandbox.json"),
          targetState: join(base, "target-state"),
          agentState: join(base, "target-state", "agents", "example"),
        };
        const isolation = await new SandboxRuntimeIsolationBackend({
          runtime,
          readOnlyPaths: [],
          readWritePaths: [allowed],
          network: { mode: "deny", allowedDomains: [] },
        }).prepare();
        if (isolation.execution.backend !== "sandbox-runtime") {
          throw new Error("Expected Sandbox Runtime execution");
        }
        await initializeSandboxRuntime(isolation.execution);

        const environment = {
          ...process.env,
          HOME: home,
          TMPDIR: sessionTemp,
          TMP: sessionTemp,
          TEMP: sessionTemp,
          OPSCAPSULE_BROKER_TOKEN: "session-token",
          OPSCAPSULE_BROKER_REFERENCE: "central-inference",
        } as Record<string, string>;

        // `sh -c` stands in for the AWS client: a process already inside the
        // sandbox that spawns the helper and captures its stdout.
        const launch = await wrapSandboxedLaunch(
          {
            command: "/bin/sh",
            args: ["-c", '"$1"', "child", helper],
            cwd: allowed,
            env: environment,
          },
          "broker-helper",
        );
        const result = await executeFile(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.env,
          timeout: 10_000,
        });
        cleanupSandboxCommand();

        const payload = JSON.parse(result.stdout);
        expect(payload.Version).toBe(1);
        expect(payload.AccessKeyId).toBe("ASIAEXAMPLE");

        // The helper must not depend on the session token arriving through
        // argv, where any other process in the capsule could read it.
        expect(launch.args.join(" ")).not.toContain("session-token");

        await resetSandboxRuntime();
      },
      20_000,
    );
  },
);

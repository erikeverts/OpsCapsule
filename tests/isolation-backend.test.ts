import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSandboxRuntimeSettings,
  SandboxRuntimeIsolationBackend,
} from "../src/main/isolation/sandbox-runtime.js";
import {
  cleanupSandboxCommand,
  initializeSandboxRuntime,
  resetSandboxRuntime,
  wrapSandboxedLaunch,
} from "../src/main/isolation/sandbox-command.js";
import { allowsPublicDestination } from "../src/main/isolation/public-network.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];
const macOsSandboxAvailable =
  process.platform === "darwin" &&
  spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)\n(allow default)", "/usr/bin/true"],
    { stdio: "ignore" },
  ).status === 0;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("sandbox policy", () => {
  it.each([
    {
      mode: "public" as const,
      allowedDomains: [],
      expectedAllowed: [],
      expectedDenied: [],
      strictAllowlist: false,
    },
    {
      mode: "deny" as const,
      allowedDomains: [],
      expectedAllowed: [],
      expectedDenied: ["*"],
      strictAllowlist: true,
    },
    {
      mode: "allowlist" as const,
      allowedDomains: ["api.github.com"],
      expectedAllowed: ["api.github.com"],
      expectedDenied: [],
      strictAllowlist: true,
    },
  ])(
    "generates a valid $mode network policy",
    ({ mode, allowedDomains, expectedAllowed, expectedDenied, strictAllowlist }) => {
      const settings = buildSandboxRuntimeSettings({
        deniedReadPaths: ["/Users", "/private/tmp"],
        readOnlyPaths: ["/workspace/docs"],
        readWritePaths: ["/workspace/app", "/private/tmp/capsule"],
        network: { mode, allowedDomains },
        userHome: "/Users/example",
      });

      expect(() => SandboxRuntimeConfigSchema.parse(settings)).not.toThrow();
      expect(settings.network.allowedDomains).toEqual(expectedAllowed);
      expect(settings.network.deniedDomains).toEqual(expectedDenied);
      expect(settings.network.strictAllowlist).toBe(strictAllowlist);
    },
  );

  it("generates a deny-by-default write policy", () => {
    const settings = buildSandboxRuntimeSettings({
      deniedReadPaths: ["/Users", "/private/tmp"],
      readOnlyPaths: ["/workspace/docs"],
      readWritePaths: ["/workspace/app", "/private/tmp/capsule"],
      network: { mode: "allowlist", allowedDomains: ["api.github.com"] },
      userHome: "/Users/example",
    });

    expect(() => SandboxRuntimeConfigSchema.parse(settings)).not.toThrow();
    expect(settings.filesystem.allowRead).toEqual([
      "/workspace/docs",
      "/workspace/app",
      "/private/tmp/capsule",
    ]);
    expect(settings.filesystem.allowWrite).toEqual([
      "/workspace/app",
      "/private/tmp/capsule",
    ]);
    expect(settings.filesystem.denyWrite).toContain(
      "/Users/example/.claude/debug",
    );
    expect(settings.network.allowAllUnixSockets).toBe(false);
    expect(settings.allowAppleEvents).toBe(false);
    expect(settings.allowPty).toBe(true);
  });

  it.each([
    ["example.com", true],
    ["8.8.8.8", true],
    ["localhost", false],
    ["service.localhost", false],
    ["127.0.0.1", false],
    ["127.1", false],
    ["169.254.169.254", false],
    ["100.100.100.200", false],
    ["::1", false],
    ["fd00:ec2::254", false],
  ])("applies public-network safety checks to %s", (host, expected) => {
    expect(allowsPublicDestination({ host, port: 443 })).toBe(expected);
  });
});

describe.skipIf(!macOsSandboxAvailable)(
  "sandbox runtime isolation",
  () => {
    it(
      "allows configured roots and denies sibling user data to child processes",
      async () => {
        const temporaryRoot =
          process.platform === "darwin" ? "/private/tmp" : tmpdir();
        const base = await mkdtemp(join(temporaryRoot, "oc-sandbox-"));
        temporaryDirectories.push(base);
        const allowed = join(base, "allowed");
        const denied = join(base, "denied");
        const root = join(base, "runtime");
        const home = join(root, "home");
        const sessionTemp = join(root, "tmp");
        await Promise.all(
          [allowed, denied, home, sessionTemp, join(base, "target-state")].map((path) =>
            mkdir(path, { recursive: true }),
          ),
        );
        const allowedFile = join(allowed, "allowed.txt");
        const deniedFile = join(denied, "denied.txt");
        await Promise.all([
          writeFile(allowedFile, "allowed\n"),
          writeFile(deniedFile, "denied\n"),
        ]);
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
        const environment = {
          ...process.env,
          HOME: home,
          TMPDIR: sessionTemp,
          TMP: sessionTemp,
          TEMP: sessionTemp,
          CLAUDE_CODE_TMPDIR: sessionTemp,
        } as Record<string, string>;

        if (isolation.execution.backend !== "sandbox-runtime") {
          throw new Error("Expected Sandbox Runtime execution");
        }
        await initializeSandboxRuntime(isolation.execution);
        const allowedLaunch = await wrapSandboxedLaunch(
          {
            command: "/bin/cat",
            args: [allowedFile],
            cwd: allowed,
            env: environment,
          },
          "allowed-read",
        );
        const allowedResult = await executeFile(
          allowedLaunch.command,
          allowedLaunch.args,
          { cwd: allowedLaunch.cwd, env: allowedLaunch.env },
        );
        cleanupSandboxCommand();
        expect(allowedResult.stdout).toBe("allowed\n");

        const deniedLaunch = await wrapSandboxedLaunch(
          {
            command: "/bin/sh",
            args: ["-c", 'cat "$1"', "child", deniedFile],
            cwd: allowed,
            env: environment,
          },
          "denied-read",
        );
        await expect(
          executeFile(deniedLaunch.command, deniedLaunch.args, {
            cwd: deniedLaunch.cwd,
            env: deniedLaunch.env,
          }),
        ).rejects.toMatchObject({ code: 1 });
        cleanupSandboxCommand();
        await resetSandboxRuntime();
      },
      20_000,
    );
  },
);

describe.skipIf(process.platform !== "darwin" || macOsSandboxAvailable)(
  "sandbox runtime preflight",
  () => {
    it("fails closed when nested macOS sandboxing is unavailable", async () => {
      const base = await mkdtemp(join("/private/tmp", "oc-preflight-"));
      temporaryDirectories.push(base);
      const runtime = {
        root: base,
        home: join(base, "home"),
        temp: join(base, "tmp"),
        kubeconfig: join(base, "kubeconfig.yaml"),
        sandboxConfig: join(base, "sandbox.json"),
        targetState: join(base, "target-state"),
        agentState: join(base, "target-state", "agents", "example"),
      };
      await Promise.all([
        mkdir(runtime.home, { recursive: true }),
        mkdir(runtime.temp, { recursive: true }),
        mkdir(runtime.targetState, { recursive: true }),
      ]);

      await expect(
        new SandboxRuntimeIsolationBackend({
          runtime,
          readOnlyPaths: [],
          readWritePaths: [base],
          network: { mode: "deny", allowedDomains: [] },
        }).prepare(),
      ).rejects.toThrow("sandbox enforcement is unavailable");
    });
  },
);

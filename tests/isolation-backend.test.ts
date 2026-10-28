import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPathAliases } from "../src/main/isolation/path-aliases.js";
import { resolvePathChain } from "../src/main/isolation/path-chain.js";
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
import {
  resolveHostGitExecutable,
  writeGitExecutableShim,
  writeHostGitConfiguration,
} from "../src/main/git-config.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];
// This guard must stay aligned with checkSandboxRuntimeAvailability: the
// backend refuses to prepare unless sandbox-exec works *and* ripgrep is on
// PATH, so a guard that only probes sandbox-exec turns a missing host
// dependency into a test failure instead of a skip.
const macOsSandboxAvailable =
  process.platform === "darwin" &&
  spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)\n(allow default)", "/usr/bin/true"],
    { stdio: "ignore" },
  ).status === 0 &&
  spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

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
      "runs direct Apple Git without host temp writes or system configuration",
      async () => {
        const base = await mkdtemp(join("/private/tmp", "oc-sandbox-git-"));
        temporaryDirectories.push(base);
        const root = join(base, "runtime");
        const home = join(root, "home");
        const sessionTemp = join(base, "temp");
        const repository = join(base, "repository");
        const targetState = join(base, "target-state");
        await Promise.all(
          [root, home, sessionTemp, repository, targetState].map((path) =>
            mkdir(path, { recursive: true }),
          ),
        );
        const gitExecutable = await resolveHostGitExecutable();
        const toolShimDirectory = await writeGitExecutableShim(
          root,
          gitExecutable,
        );
        const gitConfig = await writeHostGitConfiguration(root, {
          executable: gitExecutable,
          global: {
            name: "Capsule Operator",
            email: "operator@example.test",
          },
          repositories: [],
        });
        await executeFile(gitExecutable, ["init", "--quiet", repository], {
          env: {
            ...process.env,
            HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: gitConfig,
          },
        });
        const runtime = {
          root,
          home,
          temp: sessionTemp,
          kubeconfig: join(root, "kubeconfig.yaml"),
          sandboxConfig: join(root, "sandbox.json"),
          targetState,
          agentState: join(targetState, "agents", "example"),
          gitConfig,
          gitExecutable,
          toolShimDirectory,
        };
        const isolation = await new SandboxRuntimeIsolationBackend({
          runtime,
          readOnlyPaths: [],
          runtimeReadOnlyPaths: await resolvePathChain(gitExecutable),
          readWritePaths: [repository, targetState],
          network: { mode: "deny", allowedDomains: [] },
        }).prepare();
        if (isolation.execution.backend !== "sandbox-runtime") {
          throw new Error("Expected Sandbox Runtime execution");
        }
        await initializeSandboxRuntime(isolation.execution);
        const launch = await wrapSandboxedLaunch(
          {
            command: "/bin/sh",
            args: ["-c", "git config --list --show-origin"],
            cwd: repository,
            env: {
              ...process.env,
              HOME: home,
              TMPDIR: sessionTemp,
              TMP: sessionTemp,
              TEMP: sessionTemp,
              PATH: `${toolShimDirectory}:/usr/bin:/bin`,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: gitConfig,
            } as Record<string, string>,
          },
          "direct-git",
        );
        const result = await executeFile(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.env,
        });
        cleanupSandboxCommand();
        await resetSandboxRuntime();

        expect(result.stderr).not.toMatch(/xcrun_db|FSEvents|Operation not permitted/);
        expect(result.stdout).not.toContain("credential.helper");
        expect(result.stdout).toContain("user.name=Capsule Operator");
        expect(result.stdout).toContain("user.email=operator@example.test");
      },
      20_000,
    );

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

    it(
      "can execute one explicitly allowed user-local agent without exposing its siblings",
      async () => {
        const temporaryRoot = "/private/tmp";
        const base = await mkdtemp(join(temporaryRoot, "oc-local-agent-"));
        temporaryDirectories.push(base);
        const install = join(base, "share", "claude", "versions");
        const root = join(base, "runtime");
        const home = join(root, "home");
        const sessionTemp = join(root, "tmp");
        const targetState = join(base, "target-state");
        await Promise.all(
          [install, home, sessionTemp, targetState].map((path) =>
            mkdir(path, { recursive: true }),
          ),
        );
        const agent = join(install, "1.0.0");
        const sibling = join(install, "private.txt");
        await writeFile(agent, "#!/bin/sh\nprintf 'local-agent-ok\\n'\n");
        await chmod(agent, 0o755);
        await writeFile(sibling, "private\n");
        const runtime = {
          root,
          home,
          temp: sessionTemp,
          kubeconfig: join(root, "kubeconfig.yaml"),
          sandboxConfig: join(root, "sandbox.json"),
          targetState,
          agentState: join(targetState, "agents", "example"),
        };
        const isolation = await new SandboxRuntimeIsolationBackend({
          runtime,
          readOnlyPaths: [],
          runtimeReadOnlyPaths: [agent],
          readWritePaths: [targetState],
          network: { mode: "deny", allowedDomains: [] },
        }).prepare();
        if (isolation.execution.backend !== "sandbox-runtime") {
          throw new Error("Expected Sandbox Runtime execution");
        }
        expect(isolation.effective.readOnlyPaths).not.toContain(agent);
        await initializeSandboxRuntime(isolation.execution);
        const launch = await wrapSandboxedLaunch(
          {
            command: agent,
            args: [],
            cwd: targetState,
            env: { ...process.env, HOME: home } as Record<string, string>,
          },
          "user-local-agent",
        );
        const result = await executeFile(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.env,
        });
        cleanupSandboxCommand();
        expect(result.stdout).toBe("local-agent-ok\n");

        const denied = await wrapSandboxedLaunch(
          {
            command: "/bin/cat",
            args: [sibling],
            cwd: targetState,
            env: { ...process.env, HOME: home } as Record<string, string>,
          },
          "user-local-agent-sibling",
        );
        await expect(
          executeFile(denied.command, denied.args, {
            cwd: denied.cwd,
            env: denied.env,
          }),
        ).rejects.toMatchObject({ code: 1 });
        cleanupSandboxCommand();
        await resetSandboxRuntime();
      },
      20_000,
    );

    it(
      "reaches a root through the symbolic links it is configured behind",
      async () => {
        // Cloud storage directories are arranged this way: a link in the home
        // directory pointing at a path that is itself behind a link. Allowing
        // only the resolved path leaves the root unreachable by the name the
        // user configured, which is how this failed in practice.
        const temporaryRoot =
          process.platform === "darwin" ? "/private/tmp" : tmpdir();
        const base = await mkdtemp(join(temporaryRoot, "oc-symlink-"));
        temporaryDirectories.push(base);
        const store = join(base, "storage", "Account");
        const work = join(store, "work");
        const root = join(base, "runtime");
        const home = join(root, "home");
        const sessionTemp = join(root, "tmp");
        await Promise.all(
          [work, home, sessionTemp, join(base, "target-state")].map((path) =>
            mkdir(path, { recursive: true }),
          ),
        );
        await writeFile(join(work, "allowed.txt"), "allowed\n");
        // A sibling of the link target, which must stay out of reach.
        await writeFile(join(store, "private.txt"), "private\n");
        await symlink(store, join(base, "Account"));
        await symlink(join(base, "Account", "work"), join(base, "work"));

        const configured = join(base, "work");
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
          readWritePaths: await resolvePathChain(configured),
          network: { mode: "deny", allowedDomains: [] },
        }).prepare();
        const environment = {
          ...process.env,
          HOME: home,
          TMPDIR: sessionTemp,
        } as Record<string, string>;

        if (isolation.execution.backend !== "sandbox-runtime") {
          throw new Error("Expected Sandbox Runtime execution");
        }
        await initializeSandboxRuntime(isolation.execution);

        const throughLink = await wrapSandboxedLaunch(
          {
            command: "/bin/cat",
            args: [join(configured, "allowed.txt")],
            cwd: configured,
            env: environment,
          },
          "symlink-allowed-read",
        );
        const result = await executeFile(throughLink.command, throughLink.args, {
          cwd: throughLink.cwd,
          env: throughLink.env,
        });
        cleanupSandboxCommand();
        expect(result.stdout).toBe("allowed\n");

        // Permitting the link nodes must not widen access to what sits beside
        // the target, or following links would quietly open the whole store.
        const sibling = await wrapSandboxedLaunch(
          {
            command: "/bin/sh",
            args: ["-c", 'cat "$1"', "child", join(store, "private.txt")],
            cwd: configured,
            env: environment,
          },
          "symlink-denied-read",
        );
        await expect(
          executeFile(sibling.command, sibling.args, {
            cwd: sibling.cwd,
            env: sibling.env,
          }),
        ).rejects.toMatchObject({ code: 1 });
        cleanupSandboxCommand();
        await resetSandboxRuntime();
      },
      20_000,
    );

    it(
      "grants an alias only when it has been included",
      async () => {
        // The open panel hands back a resolved path, so the name an agent is
        // told to use can be one the workspace never mentions. Including it is
        // the user's decision, and nothing reaches the profile without it.
        const temporaryRoot =
          process.platform === "darwin" ? "/private/tmp" : tmpdir();
        const base = await mkdtemp(join(temporaryRoot, "oc-alias-"));
        temporaryDirectories.push(base);
        const store = join(base, "storage", "work");
        await mkdir(join(store, "project"), { recursive: true });
        await writeFile(join(store, "project", "file.txt"), "contents\n");
        await symlink(store, join(base, "work"));

        const picked = join(store, "project");
        const alias = join(base, "work", "project");
        const root = join(base, "runtime");
        await mkdir(join(root, "home"), { recursive: true });
        await mkdir(join(base, "target-state"), { recursive: true });
        const runtime = {
          root,
          home: join(root, "home"),
          temp: join(root, "home"),
          kubeconfig: join(root, "k.yaml"),
          sandboxConfig: join(root, "s.json"),
          targetState: join(base, "target-state"),
          agentState: join(base, "target-state", "agents", "x"),
        };

        const readThrough = async (
          allowed: string[],
          path: string,
        ): Promise<boolean> => {
          const isolation = await new SandboxRuntimeIsolationBackend({
            runtime,
            readOnlyPaths: [],
            readWritePaths: allowed,
            network: { mode: "deny", allowedDomains: [] },
          }).prepare();
          if (isolation.execution.backend !== "sandbox-runtime") {
            throw new Error("Expected Sandbox Runtime execution");
          }
          await initializeSandboxRuntime(isolation.execution);
          const launch = await wrapSandboxedLaunch(
            {
              command: "/bin/cat",
              args: [join(path, "file.txt")],
              cwd: temporaryRoot,
              env: { ...process.env, HOME: runtime.home } as Record<string, string>,
            },
            "alias-read",
          );
          try {
            await executeFile(launch.command, launch.args, {
              cwd: launch.cwd,
              env: launch.env,
            });
            return true;
          } catch {
            return false;
          } finally {
            cleanupSandboxCommand();
            await resetSandboxRuntime();
          }
        };

        // Discovery offers the alias, but offering is not granting.
        expect(await discoverPathAliases(picked)).toContain(alias);

        const withoutAlias = await resolvePathChain(picked);
        expect(await readThrough(withoutAlias, picked)).toBe(true);
        expect(await readThrough(withoutAlias, join(base, "work", "project"))).toBe(
          false,
        );

        const withAlias = [
          ...(await resolvePathChain(picked)),
          ...(await resolvePathChain(alias)),
        ];
        expect(await readThrough(withAlias, join(base, "work", "project"))).toBe(
          true,
        );
      },
      40_000,
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

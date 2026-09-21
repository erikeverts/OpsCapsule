import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  decodeWslOutput,
  isMissingNodeFailure,
  loginShellBootstrap,
  parseHelperOutput,
  WslExecutionHost,
  WslHelperClient,
  WslTerminalWorkerProcess,
  type WslCommandRunner,
  type WslProcessResult,
} from "../src/main/hosts/wsl.js";
import { resultMarker } from "../src/main/hosts/wsl-protocol.js";
import {
  encodeStdioMessage,
  type TerminalWorkerRequest,
} from "../src/main/terminal-worker-protocol.js";

const userData = "C:\\Users\\Ada\\AppData\\Roaming\\opscapsule";
const applicationRoot = "C:\\Program Files\\OpsCapsule\\resources\\app";

function fakeWslPath(windowsPath: string): string {
  const drive = windowsPath.charAt(0).toLowerCase();
  return `/mnt/${drive}${windowsPath.slice(2).split("\\").join("/")}`;
}

function ok(value: unknown): string {
  return `${resultMarker}${JSON.stringify({ ok: true, value })}\n`;
}

function result(overrides: Partial<WslProcessResult>): WslProcessResult {
  return { stdout: "", stderr: "", exitCode: 0, ...overrides };
}

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  killed = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.written.push(chunk.toString("utf8")));
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", 0));
    return true;
  }
}

function fakeRunner(
  calls: Array<{ args: string[]; input?: string }>,
  responses: Record<string, (args: string[], input?: string) => WslProcessResult>,
): WslCommandRunner {
  return async (args, input) => {
    calls.push({ args, input });
    if (args.some((argument) => argument.includes("wslpath -a -u"))) {
      return responses.wslpath?.(args, input) ?? result({});
    }
    const command = args[args.length - 1] ?? "";
    const handler = responses[command];
    if (!handler) {
      throw new Error(`Unexpected wsl.exe invocation for '${command}'`);
    }
    return handler(args, input);
  };
}

async function createHost(
  calls: Array<{ args: string[]; input?: string }>,
  extraResponses: Record<string, (args: string[], input?: string) => WslProcessResult> = {},
  spawned: Array<{ args: string[]; child: FakeChildProcess }> = [],
): Promise<WslExecutionHost> {
  return WslExecutionHost.create({
    userDataDirectory: userData,
    applicationRoot,
    distribution: "Ubuntu",
    spawnProcess: (args) => {
      const child = new FakeChildProcess();
      spawned.push({ args, child });
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    },
    run: fakeRunner(calls, {
      wslpath: (args) =>
        result({
          stdout: args
            .slice(args.indexOf("opscapsule") + 1)
            .map((windowsPath) => fakeWslPath(windowsPath))
            .join("\n")
            .concat("\n"),
        }),
      probe: () =>
        result({
          stdout: ok({
            home: "/home/ada",
            stateDirectory: "/home/ada/.local/state/opscapsule",
            shell: "/usr/bin/zsh",
            nodeVersion: "v22.0.0",
            distribution: "Ubuntu",
          }),
        }),
      ...extraResponses,
    }),
  });
}

describe("WSL execution host", () => {
  it("translates application paths through wslpath and probes the helper", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const host = await createHost(calls);

    expect(calls[0]?.args).toEqual([
      "--distribution",
      "Ubuntu",
      "--exec",
      "/bin/sh",
      "-c",
      expect.stringContaining("wslpath -a -u"),
      "opscapsule",
      userData,
      applicationRoot,
    ]);
    expect(calls[1]?.args.slice(-3)).toEqual([
      "node",
      "/mnt/c/Program Files/OpsCapsule/resources/app/dist/wsl-helper.cjs",
      "probe",
    ]);
    expect(host.id).toBe("wsl");
    expect(host.label).toBe("WSL (Ubuntu)");
    expect(host.home).toBe("/home/ada");
    expect(host.stateDirectory).toBe("/home/ada/.local/state/opscapsule");
  });

  it("resolves manifest-relative paths inside the distribution", async () => {
    const host = await createHost([]);
    const manifest = `${userData}\\config\\workspaces\\atlas.yaml`;

    expect(host.paths.manifestDirectory(manifest)).toBe(
      "/mnt/c/Users/Ada/AppData/Roaming/opscapsule/config/workspaces",
    );
    expect(host.paths.path.resolve(host.paths.manifestDirectory(manifest), "../repo")).toBe(
      "/mnt/c/Users/Ada/AppData/Roaming/opscapsule/config/repo",
    );
    expect(() => host.paths.manifestDirectory("D:\\elsewhere\\x.yaml")).toThrow(
      "outside the application data directory",
    );
  });

  it("runs the terminal worker inside the distribution over a stdio pipe", async () => {
    const spawned: Array<{ args: string[]; child: FakeChildProcess }> = [];
    const host = await createHost([], {}, spawned);

    const worker = host.forkTerminalWorker({
      cwd: "/home/ada/projects/app",
      env: { HOME: "/home/ada/.local/state/opscapsule/sessions/s/home" },
    });
    const events: unknown[] = [];
    worker.on("spawn", () => events.push("spawn"));
    worker.on("message", (message) => events.push(message));
    worker.on("exit", (code) => events.push(`exit:${code}`));

    expect(spawned).toHaveLength(1);
    const { args, child } = spawned[0]!;
    expect(args.slice(0, 7)).toEqual([
      "--distribution",
      "Ubuntu",
      "--cd",
      "/home/ada/projects/app",
      "--exec",
      "/bin/sh",
      "-c",
    ]);
    expect(args[7]).toContain('exec "$SHELL" -l -c');
    expect(args.slice(-4)).toEqual([
      "opscapsule",
      "node",
      "/mnt/c/Program Files/OpsCapsule/resources/app/dist/terminal-worker.cjs",
      "--stdio",
    ]);

    const request: TerminalWorkerRequest = {
      type: "initialize",
      isolation: { backend: "none" },
    };
    worker.postMessage(request);
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.written.join("")).toBe(`${JSON.stringify(request)}\n`);

    child.stdout.write("Welcome to Ubuntu\n");
    child.stdout.write(`motd without newline${encodeStdioMessage({ type: "ready" })}`);
    child.stdout.write(
      encodeStdioMessage({ type: "terminal-data", terminalId: "t", data: "hi" }).slice(0, 20),
    );
    child.stdout.write(
      encodeStdioMessage({ type: "terminal-data", terminalId: "t", data: "hi" }).slice(20),
    );
    child.emit("close", 0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(events).toEqual([
      "spawn",
      { type: "ready" },
      { type: "terminal-data", terminalId: "t", data: "hi" },
      "exit:0",
    ]);
  });

  it("reports startup noise when the worker never answers", async () => {
    const child = new FakeChildProcess();
    const worker = new WslTerminalWorkerProcess(child as unknown as ChildProcess);
    const errors: string[] = [];
    let exitCode: number | undefined;
    worker.on("error", (_type, _location, report) => errors.push(report));
    worker.on("exit", (code) => {
      exitCode = code;
    });

    child.stdout.write(Buffer.from("There is no distribution with the supplied name.", "utf16le"));
    child.emit("close", 1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toEqual(["There is no distribution with the supplied name."]);
    expect(exitCode).toBe(1);
    expect(worker.kill()).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("delegates runtime and isolation preparation to the helper", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const runtime = {
      root: "/home/ada/.local/state/opscapsule/sessions/s",
      home: "/home/ada/.local/state/opscapsule/sessions/s/home",
      temp: "/tmp/opscapsule-s",
      kubeconfig: "/home/ada/.local/state/opscapsule/sessions/s/kubeconfig.yaml",
      sandboxConfig: "/home/ada/.local/state/opscapsule/sessions/s/sandbox.json",
      targetState: "/home/ada/.local/state/opscapsule/state/workspaces/w/targets/t",
      agentState: "/home/ada/.local/state/opscapsule/state/workspaces/w/targets/t/agents/a",
    };
    const host = await createHost(calls, {
      "prepare-isolation": () =>
        result({
          stdout: ok({
            effective: {
              mode: "enforced",
              backend: "sandbox-runtime",
              readOnlyPaths: [],
              readWritePaths: ["/home/ada/projects/app"],
              networkMode: "deny",
            },
            execution: {
              backend: "sandbox-runtime",
              settingsPath: runtime.sandboxConfig,
              networkMode: "deny",
            },
          }),
        }),
      "cleanup-runtime": () => result({ stdout: ok({}) }),
      "check-readiness": () =>
        result({ stdout: ok({ status: "ready", checks: [] }) }),
      "delete-workspace-state": () => result({ stdout: ok({}) }),
    });

    const isolation = await host.prepareIsolation(runtime, {
      workspace: {
        manifest: {},
        sourcePath: `${userData}\\config\\workspaces\\atlas\\workspace.yaml`,
      },
    } as never);
    const request = JSON.parse(calls.at(-1)?.input ?? "{}") as {
      runtime: typeof runtime;
      resolvedTarget: { workspace: { sourcePath: string } };
    };
    expect(request.runtime).toEqual(runtime);
    expect(request.resolvedTarget.workspace.sourcePath).toBe(
      "/mnt/c/Users/Ada/AppData/Roaming/opscapsule/config/workspaces/atlas/workspace.yaml",
    );
    expect(isolation.effective.backend).toBe("sandbox-runtime");
    expect(isolation.execution).toEqual({
      backend: "sandbox-runtime",
      settingsPath: runtime.sandboxConfig,
      networkMode: "deny",
    });

    await host.cleanupRuntime(runtime);
    expect(calls.at(-1)?.args.at(-1)).toBe("cleanup-runtime");

    const readiness = await host.checkTargetReadiness({
      workspace: {
        manifest: {},
        sourcePath: `${userData}\\config\\workspaces\\atlas\\workspace.yaml`,
      },
    } as never);
    expect(readiness.status).toBe("ready");
    expect(calls.at(-1)?.args.at(-1)).toBe("check-readiness");

    await host.deleteWorkspaceState("atlas");
    expect(JSON.parse(calls.at(-1)?.input ?? "{}")).toEqual({
      baseDirectory: "/home/ada/.local/state/opscapsule",
      workspaceId: "atlas",
    });
  });

  it("translates dialog paths and inspects directories inside the distribution", async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const host = await createHost(calls, {
      "inspect-directory": () =>
        result({
          stdout: ok({
            path: "/mnt/d/repos/app",
            versionControl: { system: "git", root: "/mnt/d/repos/app" },
          }),
        }),
    });
    const initialCalls = calls.length;

    await expect(host.translateHostPath("D:\\repos\\app")).resolves.toBe(
      "/mnt/d/repos/app",
    );
    expect(calls[initialCalls]?.args.at(-1)).toBe("D:\\repos\\app");

    const inspection = await host.inspectDirectory("/mnt/d/repos/app");
    expect(inspection.path).toBe("/mnt/d/repos/app");
    expect(calls.at(-1)?.args.at(-1)).toBe("inspect-directory");
  });

  it("surfaces helper errors and fails closed", async () => {
    const host = await createHost([], {
      "create-runtime": () =>
        result({
          stdout: `${resultMarker}${JSON.stringify({ ok: false, error: "Cluster 'x' was not found" })}\n`,
          exitCode: 1,
        }),
    });

    await expect(
      host.createRuntime("s", {
        workspace: { manifest: {}, sourcePath: `${userData}\\config\\workspaces\\x\\workspace.yaml` },
      } as never),
    ).rejects.toThrow(
      "Cluster 'x' was not found",
    );
  });

  it("reports WSL that is not installed or ready", async () => {
    await expect(
      WslExecutionHost.create({
        userDataDirectory: userData,
        applicationRoot,
        run: async () => {
          throw new Error("spawn wsl.exe ENOENT");
        },
      }),
    ).rejects.toThrow("requires WSL 2");

    await expect(
      WslExecutionHost.create({
        userDataDirectory: userData,
        applicationRoot,
        run: async () =>
          result({
            exitCode: -1,
            stderr: "There is no distribution with the supplied name.",
          }),
      }),
    ).rejects.toThrow("WSL is not ready");
  });
});

describe("WSL helper client", () => {
  it("falls back to an interactive login shell when Node.js is only configured there", async () => {
    const calls: string[] = [];
    const client = new WslHelperClient(
      async (args) => {
        const bootstrap = args.find((argument) => argument.startsWith("case ")) ?? "";
        const interactive = bootstrap.includes("-l -i");
        calls.push(interactive ? "interactive" : "login");
        return interactive
          ? result({ stdout: ok({ probed: true }) })
          : result({ exitCode: 127, stderr: "/bin/bash: line 1: exec: node: not found" });
      },
      [],
      "/mnt/c/app/dist/wsl-helper.cjs",
    );

    expect(await client.call("probe", {})).toEqual({ probed: true });
    expect(await client.call("probe", {})).toEqual({ probed: true });
    expect(calls).toEqual(["login", "interactive", "interactive"]);
  });

  it("explains a missing Node.js installation", async () => {
    const client = new WslHelperClient(
      async () =>
        result({ exitCode: 127, stderr: "sh: 1: exec: node: not found" }),
      [],
      "/mnt/c/app/dist/wsl-helper.cjs",
    );

    await expect(client.call("probe", {})).rejects.toThrow(
      "Node.js was not found on the login-shell PATH inside WSL",
    );
  });

  it("does not retry on unrelated failures", async () => {
    let attempts = 0;
    const client = new WslHelperClient(
      async () => {
        attempts += 1;
        return result({ exitCode: 1, stderr: "helper crashed" });
      },
      [],
      "/mnt/c/app/dist/wsl-helper.cjs",
    );

    await expect(client.call("probe", {})).rejects.toThrow("helper crashed");
    expect(attempts).toBe(1);
  });
});

describe("WSL output handling", () => {
  it("decodes UTF-16LE diagnostics from wsl.exe and UTF-8 from Linux", () => {
    expect(decodeWslOutput(Buffer.from("no distribution", "utf16le"))).toBe(
      "no distribution",
    );
    expect(decodeWslOutput(Buffer.from("/home/ada\n", "utf8"))).toBe("/home/ada\n");
  });

  it("finds the marked result despite shell profile noise", () => {
    const parsed = parseHelperOutput(
      `Welcome!\nno newline before marker${resultMarker}{"ok":true,"value":{"a":1}}\ntrailing\n`,
    );
    expect(parsed).toEqual({ ok: true, value: { a: 1 } });
    expect(parseHelperOutput("nothing here")).toBeUndefined();
  });

  it("recognises a missing node executable", () => {
    expect(isMissingNodeFailure(result({ exitCode: 127 }))).toBe(true);
    expect(
      isMissingNodeFailure(result({ exitCode: 1, stderr: "zsh:1: command not found: node" })),
    ).toBe(true);
    expect(isMissingNodeFailure(result({ exitCode: 1, stderr: "boom" }))).toBe(false);
  });

  it("builds a bootstrap that never interpolates arguments", () => {
    const script = loginShellBootstrap(false);
    expect(script).toContain('exec "$SHELL" -l -c \'exec "$@"\' opscapsule "$@"');
    expect(loginShellBootstrap(true)).toContain('-l -i -c');
  });
});

import { describe, expect, it } from "vitest";
import {
  decodeWslOutput,
  isMissingNodeFailure,
  loginShellBootstrap,
  parseHelperOutput,
  toEnvironmentArguments,
  WslExecutionHost,
  WslHelperClient,
  type WslCommandRunner,
  type WslProcessResult,
} from "../src/main/hosts/wsl.js";
import { resultMarker } from "../src/main/hosts/wsl-protocol.js";

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
): Promise<WslExecutionHost> {
  return WslExecutionHost.create({
    userDataDirectory: userData,
    applicationRoot,
    distribution: "Ubuntu",
    hostEnvironment: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" },
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

  it("launches terminals through wsl.exe with an explicit environment", async () => {
    const host = await createHost([]);

    const launch = host.launch({
      command: "/usr/bin/zsh",
      args: ["-l"],
      cwd: "/home/ada/projects/app",
      env: { HOME: "/home/ada/.local/state/opscapsule/sessions/s/home", PATH: "/usr/bin" },
    });

    expect(launch.file).toBe("wsl.exe");
    expect(launch.args).toEqual([
      "--distribution",
      "Ubuntu",
      "--cd",
      "/home/ada/projects/app",
      "--exec",
      "/usr/bin/env",
      "-i",
      "TERM=xterm-256color",
      "HOME=/home/ada/.local/state/opscapsule/sessions/s/home",
      "PATH=/usr/bin",
      "/usr/bin/zsh",
      "-l",
    ]);
    expect(launch.cwd).toBeUndefined();
    expect(launch.env).toEqual({
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
    });
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
            launcher: {
              command: "/usr/bin/node",
              args: ["/mnt/c/app/dist/sandbox-runner.mjs", "--settings", runtime.sandboxConfig, "--network-mode", "deny", "--"],
            },
          }),
        }),
      "cleanup-runtime": () => result({ stdout: ok({}) }),
    });

    const isolation = await host.prepareIsolation(runtime, {
      workspace: {
        manifest: {},
        sourcePath: `${userData}\\config\\workspaces\\atlas\\workspace.yaml`,
      },
    } as never);
    const request = JSON.parse(calls.at(-1)?.input ?? "{}") as {
      applicationRoot: string;
      resolvedTarget: { workspace: { sourcePath: string } };
    };
    expect(request.applicationRoot).toBe("/mnt/c/Program Files/OpsCapsule/resources/app");
    expect(request.resolvedTarget.workspace.sourcePath).toBe(
      "/mnt/c/Users/Ada/AppData/Roaming/opscapsule/config/workspaces/atlas/workspace.yaml",
    );
    expect(isolation.effective.backend).toBe("sandbox-runtime");

    const wrapped = isolation.wrap({
      command: "/bin/bash",
      args: [],
      cwd: "/home/ada/projects/app",
      env: { HOME: runtime.home, WSL_INTEROP: "/run/WSL/1_interop" },
    });
    expect(wrapped.command).toBe("/usr/bin/node");
    expect(wrapped.args.slice(-2)).toEqual(["--", "/bin/bash"]);
    expect(wrapped.env.WSL_INTEROP).toBeUndefined();
    expect(wrapped.env.HOME).toBe(runtime.home);

    await host.cleanupRuntime(runtime);
    expect(calls.at(-1)?.args.at(-1)).toBe("cleanup-runtime");
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

  it("serialises environment entries and skips invalid names", () => {
    expect(
      toEnvironmentArguments({ A: "1", "B C": "2", "D=E": "3", PS1: "[x] \\w $ " }),
    ).toEqual(["A=1", "PS1=[x] \\w $ "]);
  });

  it("builds a bootstrap that never interpolates arguments", () => {
    const script = loginShellBootstrap(false);
    expect(script).toContain('exec "$SHELL" -l -c \'exec "$@"\' opscapsule "$@"');
    expect(loginShellBootstrap(true)).toContain('-l -i -c');
  });
});

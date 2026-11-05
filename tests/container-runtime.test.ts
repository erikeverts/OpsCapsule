import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildColimaStartArguments,
  ColimaContainerRuntime,
  createColimaRuntimePaths,
  type ContainerCommandRunner,
} from "../src/main/container-runtimes/colima.js";
import {
  buildWorkspaceEnvironment,
  createWorkspaceRuntime,
} from "../src/main/runtime-directory.js";
import { WorkspaceRegistry } from "../src/main/workspace-registry.js";
import { parseWorkspaceManifest } from "../src/shared/workspace-schema.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function configuredTarget() {
  const root = await mkdtemp(join(tmpdir(), "opscapsule-containers-"));
  temporaryDirectories.push(root);
  const registry = new WorkspaceRegistry(root);
  await registry.initialize();
  const document = await registry.document("atlas");
  document.manifest.targets[0]!.containerRuntime = {
    mode: "isolated",
    provider: "colima",
    persistence: "target",
    resources: { cpus: 3, memoryGiB: 6, diskGiB: 48 },
  };
  document.manifest.targets[0]!.isolation.mode = "enforced";
  document.manifest.targets[0]!.isolation.network = {
    mode: "public",
    allowedDomains: [],
  };
  await registry.save("atlas", document.revision, document.manifest);
  return {
    root,
    target: await registry.resolveTarget("atlas", "development"),
  };
}

describe("isolated container runtime", () => {
  it("validates the containment requirements in the manifest", () => {
    const base = {
      apiVersion: "opscapsule.dev/v1alpha1",
      kind: "Workspace",
      metadata: { id: "example", name: "Example" },
      directories: [
        {
          id: "project",
          name: "Project",
          path: "/tmp/project",
          access: "read-write",
        },
      ],
      targets: [
        {
          id: "development",
          name: "Development",
          environment: "development",
          risk: "development",
          directories: ["project"],
          defaultDirectory: "project",
          agentRuntime: { adapter: "command", command: "$SHELL", args: [] },
          context: { metadata: [], documents: [] },
          containerRuntime: { mode: "isolated" },
          isolation: {
            mode: "enforced",
            network: { mode: "public", allowedDomains: [] as string[] },
          },
        },
      ],
    };

    const parsed = parseWorkspaceManifest(base);
    expect(parsed.targets[0]?.containerRuntime?.resources).toEqual({
      cpus: 4,
      memoryGiB: 8,
      diskGiB: 60,
    });

    const contextOnly = structuredClone(base);
    contextOnly.targets[0]!.isolation.mode = "context-only";
    expect(() => parseWorkspaceManifest(contextOnly)).toThrow(
      "needs enforced isolation",
    );

    const allowlisted = structuredClone(base);
    allowlisted.targets[0]!.isolation.network = {
      mode: "allowlist",
      allowedDomains: ["example.com"],
    };
    expect(() => parseWorkspaceManifest(allowlisted)).toThrow(
      "requires public network mode",
    );
  });

  it("uses a short socket alias and target-private Docker client state", async () => {
    const { root, target } = await configuredTarget();
    const runtime = await createWorkspaceRuntime(
      root,
      "container-session",
      target,
    );
    const paths = runtime.containerRuntime!;
    const environment = buildWorkspaceEnvironment(runtime, target);

    expect(paths.stateDirectory).not.toContain(runtime.targetState);
    expect(paths.dockerConfig).toContain(runtime.targetState);
    expect(paths.colimaHome).toMatch(/^\/private\/tmp\/opscapsule-cr-/);
    expect(Buffer.byteLength(paths.socket) + 1).toBeLessThanOrEqual(104);
    expect(environment.DOCKER_HOST).toBe(`unix://${paths.socket}`);
    expect(environment.DOCKER_CONFIG).toBe(paths.dockerConfig);
    expect(environment.DOCKER_CONTEXT).toBeUndefined();
  });

  it("starts Colima without host activation, home mounts, or SSH forwarding", async () => {
    const { root, target } = await configuredTarget();
    const targetState = join(root, "target-state");
    await mkdir(targetState, { recursive: true });
    const paths = await createColimaRuntimePaths(root, targetState, target);
    await mkdir(join(paths.colimaHome, paths.profile), { recursive: true });
    await writeFile(paths.socket, "test socket placeholder");
    const calls: Array<{
      executable: string;
      args: string[];
      env: NodeJS.ProcessEnv;
    }> = [];
    const execute: ContainerCommandRunner = async (executable, args, options) => {
      calls.push({ executable, args, env: options.env });
      return { stdout: "", stderr: "" };
    };
    const runtime = {
      root,
      home: join(root, "home"),
      temp: join(root, "temp"),
      kubeconfig: join(root, "kubeconfig"),
      sandboxConfig: join(root, "sandbox.json"),
      targetState,
      agentState: join(targetState, "agent"),
      containerRuntime: paths,
    };
    const provider = new ColimaContainerRuntime(
      execute,
      async (command) => `/tools/${command}`,
      "darwin",
    );

    await provider.start(runtime, target);

    expect(calls[0]).toEqual(expect.objectContaining({
      executable: "/tools/colima",
      args: ["stop", paths.profile, "--force"],
    }));
    expect(calls[1]).toEqual(expect.objectContaining({
      executable: "/tools/colima",
      args: buildColimaStartArguments(target),
    }));
    expect(calls[1]!.args).toEqual(
      expect.arrayContaining([
        "--activate=false",
        "--template=false",
        "--ssh-agent=false",
        "--ssh-config=false",
        "--port-forwarder=none",
        "--network-address=false",
      ]),
    );
    expect(calls[1]!.args.join(" ")).not.toContain(process.env.HOME ?? "~");
    expect(calls[1]!.env).toEqual(
      expect.objectContaining({
        COLIMA_HOME: paths.colimaHome,
        LIMA_HOME: join(paths.colimaHome, "_lima"),
        DOCKER_CONFIG: paths.dockerConfig,
      }),
    );
    expect(calls[2]!.args).toEqual(
      expect.arrayContaining([
        "--host",
        `unix://${paths.socket}`,
        "version",
      ]),
    );
  });
});

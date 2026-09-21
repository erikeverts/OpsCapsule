import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutionHost } from "../src/main/hosts/local.js";
import type { TerminalWorkerProcess } from "../src/main/hosts/types.js";
import { WorkspaceRegistry } from "../src/main/workspace-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("local execution host", () => {
  it("creates capsule runtimes with a resolved working directory and environment", async () => {
    const userData = await mkdtemp(join(tmpdir(), "opscapsule-local-host-"));
    temporaryDirectories.push(userData);
    const forks: Array<{ modulePath: string; args: string[]; options: unknown }> = [];
    const fakeWorker = {} as TerminalWorkerProcess;
    const host = new LocalExecutionHost({
      userDataDirectory: userData,
      applicationRoot: process.cwd(),
      forkUtilityProcess: (modulePath, args, options) => {
        forks.push({ modulePath, args, options });
        return fakeWorker;
      },
    });
    const registry = new WorkspaceRegistry(userData, {
      paths: host.paths,
      demoRoot: host.path.join(host.stateDirectory, "demo-workspaces"),
      createDemoDirectories: (directories) => host.createDemoDirectories(directories),
    });
    await registry.initialize();
    const target = await registry.resolveTarget("borealis", "staging");

    const capsule = await host.createRuntime("local-session", target);
    temporaryDirectories.push(capsule.runtime.temp);

    expect(host.id).toBe("local");
    expect(host.path).toBe(path);
    expect(capsule.workingDirectory).toBe(target.defaultDirectory.path);
    expect(capsule.environment.HOME).toBe(capsule.runtime.home);
    expect(capsule.environment.AWS_PROFILE).toBe("borealis-stage");
    expect((await stat(capsule.runtime.home)).isDirectory()).toBe(true);

    const worker = host.forkTerminalWorker({
      cwd: capsule.workingDirectory,
      env: capsule.environment,
    });
    expect(worker).toBe(fakeWorker);
    expect(forks).toEqual([
      {
        modulePath: join(process.cwd(), "dist", "terminal-worker.cjs"),
        args: [],
        options: {
          cwd: capsule.workingDirectory,
          env: capsule.environment,
          stdio: "pipe",
          serviceName: "OpsCapsule Terminal Worker",
        },
      },
    ]);

    await host.cleanupRuntime(capsule.runtime);
    await expect(stat(capsule.runtime.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create a runtime when the default directory is missing", async () => {
    const userData = await mkdtemp(join(tmpdir(), "opscapsule-local-host-"));
    temporaryDirectories.push(userData);
    const host = new LocalExecutionHost({
      userDataDirectory: userData,
      applicationRoot: process.cwd(),
    });
    const registry = new WorkspaceRegistry(userData);
    await registry.initialize();
    const target = await registry.resolveTarget("atlas", "development");
    await rm(target.defaultDirectory.path, { recursive: true, force: true });

    await expect(host.createRuntime("missing", target)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(join(userData, "sessions", "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

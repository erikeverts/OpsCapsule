// Manual verification for the Windows/WSL execution host. Runs the production
// host, helper, terminal worker, and an enforced demo capsule against the real
// wsl.exe without Electron, then checks isolation from inside the capsule.
//
//   npm run verify:wsl-host            full run, stops the capsule cleanly
//   npm run verify:wsl-host -- abrupt  exits mid-session to check that the
//                                      worker inside WSL shuts down on its own
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WslExecutionHost } from "../src/main/hosts/wsl.js";
import { TerminalManager } from "../src/main/terminal-manager.js";
import { WorkspaceRegistry } from "../src/main/workspace-registry.js";

const mode = process.argv[2] ?? "full";
const output = new Map<string, string>();
const exits = new Map<string, number>();
const failures: string[] = [];

function log(...parts: unknown[]): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...parts);
}

function expect(condition: boolean, description: string): void {
  log(condition ? "ok  " : "FAIL", description);
  if (!condition) {
    failures.push(description);
  }
}

async function waitFor(predicate: () => boolean, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("verify:wsl-host must run on Windows");
  }
  const userData = await mkdtemp(join(tmpdir(), "opscapsule-verify-wsl-"));
  const host = await WslExecutionHost.create({
    userDataDirectory: userData,
    applicationRoot: process.cwd(),
    distribution: process.env.OPSCAPSULE_WSL_DISTRO || undefined,
  });
  log("host", host.label, "state:", host.stateDirectory);
  await host.cleanupStaleRuntimes();

  const registry = new WorkspaceRegistry(userData, {
    paths: host.paths,
    demoRoot: host.path.join(host.stateDirectory, "demo-workspaces"),
    createDemoDirectories: (directories) => host.createDemoDirectories(directories),
    deleteWorkspaceState: (workspaceId) => host.deleteWorkspaceState(workspaceId),
  });
  await registry.initialize();
  const target = await registry.resolveTarget("atlas", "development");

  const readiness = await host.checkTargetReadiness(target);
  for (const check of readiness.checks) {
    log(`  ${check.status.padEnd(7)} ${check.id}: ${check.detail}`);
  }
  expect(readiness.status !== "blocked", "target readiness is not blocked");

  const manager = new TerminalManager({
    host,
    events: {
      data: ({ terminalId, data }) =>
        output.set(terminalId, (output.get(terminalId) ?? "") + data),
      exit: ({ terminalId, exitCode }) => exits.set(terminalId, exitCode),
    },
  });
  const sessionId = manager.createSessionId();
  const started = Date.now();
  const capsule = await host.createRuntime(sessionId, target);
  const isolation = await host.prepareIsolation(capsule.runtime, target);
  const session = await manager.startWorkspace(sessionId, target, capsule, isolation);
  log("session started in", `${Date.now() - started}ms`, session.terminals.map((t) => t.title));
  expect(session.isolation.backend === "sandbox-runtime", "capsule is enforced");

  if (mode === "abrupt") {
    log("exiting without stopSession; check `pgrep -af terminal-worker.cjs` inside WSL");
    process.exit(0);
  }

  const shell = session.terminals[1]!.id;
  for (const terminal of session.terminals) {
    manager.attach(session.id, terminal.id);
  }
  manager.resize(session.id, shell, 132, 40);
  manager.write(
    session.id,
    shell,
    [
      "echo MARK-cols=$(tput cols)",
      "echo MARK-home=$HOME",
      "echo MARK-cwd=$PWD",
      "ls /mnt/c/Users >/dev/null 2>&1 && echo MARK-drive=visible || echo MARK-drive=denied",
      "touch ../documentation/probe 2>/dev/null && echo MARK-ro=writable || echo MARK-ro=denied",
      "touch ./probe && rm ./probe && echo MARK-rw=ok || echo MARK-rw=denied",
      "echo MARK-interop=${WSL_INTEROP:-unset}",
      "exit 7",
    ].join("; ") + "\n",
  );
  await waitFor(() => exits.has(shell), 20_000);
  const marks = Object.fromEntries(
    [...(output.get(shell) ?? "").matchAll(/^MARK-([a-z]+)=(.*)$/gm)].map((m) => [m[1], m[2]]),
  );
  expect(exits.get(shell) === 7, "shell exit code is forwarded");
  expect(marks.cols === "132", `resize reached the pty (cols=${marks.cols})`);
  expect(marks.home === capsule.runtime.home, "HOME is the synthetic capsule home");
  expect(marks.cwd === capsule.workingDirectory, "cwd is the target default directory");
  expect(marks.drive === "denied", "Windows drive is not readable");
  expect(marks.ro === "denied", "read-only directory rejects writes");
  expect(marks.rw === "ok", "read-write directory accepts writes");
  expect(marks.interop === "unset", "WSL_INTEROP is not present");

  const stopping = Date.now();
  await manager.stopSession(session.id);
  log("session stopped in", `${Date.now() - stopping}ms`);
  expect(exits.size === session.terminals.length, "every terminal reported an exit");
  await rm(userData, { recursive: true, force: true });

  if (failures.length > 0) {
    throw new Error(`${failures.length} check(s) failed`);
  }
  log("WSL host verification passed.");
}

main().catch((error: unknown) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});

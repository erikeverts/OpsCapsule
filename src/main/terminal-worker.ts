import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "node-pty";
import {
  cleanupSandboxCommand,
  initializeSandboxRuntime,
  resetSandboxRuntime,
  wrapSandboxedLaunch,
} from "./isolation/sandbox-command.js";
import type { PreparedIsolation } from "./isolation/types.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerResponse,
} from "./terminal-worker-protocol.js";

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error("Terminal worker must be launched as an Electron utility process");
}

const terminals = new Map<string, pty.IPty>();
const executeFile = promisify(execFile);
let isolation: PreparedIsolation["execution"] | undefined;
let shuttingDown = false;
let emptyWaiter: (() => void) | undefined;

function post(message: TerminalWorkerResponse): void {
  parentPort.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noteTerminalExit(): void {
  if (terminals.size === 0) {
    emptyWaiter?.();
    emptyWaiter = undefined;
  }
}

async function initialize(
  requestedIsolation: PreparedIsolation["execution"],
): Promise<void> {
  if (isolation) {
    throw new Error("Terminal worker is already initialized");
  }
  isolation = requestedIsolation;
  if (isolation.backend === "sandbox-runtime") {
    await initializeSandboxRuntime(isolation);
  }
  post({ type: "ready" });
}

async function startTerminal(
  request: Extract<TerminalWorkerRequest, { type: "start-terminal" }>,
): Promise<void> {
  if (!isolation) {
    throw new Error("Terminal worker has not been initialized");
  }
  if (shuttingDown) {
    throw new Error("Terminal worker is shutting down");
  }
  if (terminals.has(request.terminalId)) {
    throw new Error("Terminal already exists");
  }

  if (request.verifyExecutable && isolation.backend === "sandbox-runtime") {
    const probe = await wrapSandboxedLaunch(
      {
        command: "/bin/test",
        args: ["-x", request.launchSpec.command],
        cwd: request.launchSpec.cwd,
        env: request.launchSpec.env,
      },
      `${request.terminalId}-executable-probe`,
    );
    try {
      await executeFile(probe.command, probe.args, {
        cwd: probe.cwd,
        env: probe.env,
        timeout: 10_000,
      });
    } catch {
      throw new Error(
        `Agent command '${request.launchSpec.command}' exists but is not reachable inside this target's sandbox`,
      );
    } finally {
      cleanupSandboxCommand();
    }
  }
  const launchSpec = isolation.backend === "sandbox-runtime"
    ? await wrapSandboxedLaunch(request.launchSpec, request.terminalId)
    : request.launchSpec;
  const terminal = pty.spawn(launchSpec.command, launchSpec.args, {
    name: "xterm-256color",
    cols: request.cols,
    rows: request.rows,
    cwd: launchSpec.cwd,
    env: launchSpec.env,
  });
  terminals.set(request.terminalId, terminal);
  terminal.onData((data) => {
    post({ type: "terminal-data", terminalId: request.terminalId, data });
  });
  terminal.onExit(({ exitCode }) => {
    terminals.delete(request.terminalId);
    if (isolation?.backend === "sandbox-runtime") {
      cleanupSandboxCommand();
    }
    post({ type: "terminal-exit", terminalId: request.terminalId, exitCode });
    noteTerminalExit();
  });
  post({ type: "terminal-started", terminalId: request.terminalId });
}

async function waitForTerminals(): Promise<void> {
  if (terminals.size === 0) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => {
      emptyWaiter = resolve;
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
  ]);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const terminal of terminals.values()) {
    terminal.kill();
  }
  await waitForTerminals();
  if (isolation?.backend === "sandbox-runtime") {
    await resetSandboxRuntime();
  }
  process.exit(0);
}

async function handle(request: TerminalWorkerRequest): Promise<void> {
  switch (request.type) {
    case "initialize":
      await initialize(request.isolation);
      return;
    case "start-terminal":
      try {
        await startTerminal(request);
      } catch (error) {
        post({
          type: "terminal-error",
          terminalId: request.terminalId,
          message: errorMessage(error),
        });
      }
      return;
    case "write":
      terminals.get(request.terminalId)?.write(request.data);
      return;
    case "resize":
      terminals.get(request.terminalId)?.resize(request.cols, request.rows);
      return;
    case "kill-terminal":
      terminals.get(request.terminalId)?.kill();
      return;
    case "shutdown":
      await shutdown();
  }
}

parentPort.on("message", (event) => {
  void handle(event.data as TerminalWorkerRequest).catch((error: unknown) => {
    post({ type: "fatal-error", message: errorMessage(error) });
    void shutdown().finally(() => process.exit(1));
  });
});

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

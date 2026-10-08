import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "node-pty";
import {
  cleanupSandboxCommand,
  initializeSandboxRuntime,
  resetSandboxRuntime,
  wrapSandboxedLaunch,
} from "./isolation/sandbox-command.js";
import {
  describeSandboxFailure,
  explainProbeFailure,
} from "./isolation/sandbox-diagnostics.js";
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

// Used both to test the agent command and, when that fails, to test whether
// the sandbox can run anything at all.
const PROBE_COMMAND = "/bin/test";
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

/**
 * Runs `test -x <target>` inside the sandbox. Returns nothing on success, or
 * whatever the failure said, since discarding that leaves no way to tell why
 * a capsule would not start.
 */
async function probeInsideSandbox(
  target: string,
  request: Extract<TerminalWorkerRequest, { type: "start-terminal" }>,
  commandId: string,
): Promise<string | undefined> {
  try {
    const probe = await wrapSandboxedLaunch(
      {
        command: PROBE_COMMAND,
        args: ["-x", target],
        cwd: request.launchSpec.cwd,
        env: request.launchSpec.env,
      },
      commandId,
    );
    await executeFile(probe.command, probe.args, {
      cwd: probe.cwd,
      env: probe.env,
      timeout: 10_000,
    });
    return undefined;
  } catch (error) {
    return explainProbeFailure(error);
  } finally {
    cleanupSandboxCommand();
  }
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
    const failure = await probeInsideSandbox(
      request.launchSpec.command,
      request,
      `${request.terminalId}-executable-probe`,
    );
    if (failure) {
      // A failed probe has two very different causes: the command is not
      // reachable, or the sandbox could not start at all. Probing the prober
      // tells them apart, and they need different fixes.
      const sandboxItself = await probeInsideSandbox(
        PROBE_COMMAND,
        request,
        `${request.terminalId}-sandbox-probe`,
      );
      if (sandboxItself) {
        throw new Error(
          `The sandbox could not start on this host, so '${request.launchSpec.command}' ` +
            `was not launched. ${describeSandboxFailure(sandboxItself)}`,
        );
      }
      throw new Error(
        `Agent command '${request.launchSpec.command}' exists but is not reachable ` +
          `inside this target's sandbox. ${failure}`,
      );
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

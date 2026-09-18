import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import * as pty from "node-pty";
import {
  cleanupSandboxCommand,
  initializeSandboxRuntime,
  resetSandboxRuntime,
  wrapSandboxedLaunch,
} from "./isolation/sandbox-command.js";
import type { PreparedIsolation } from "./isolation/types.js";
import { prepareAgentLaunch } from "./runtime-adapters/readiness.js";
import {
  encodeStdioMessage,
  stdioTransportFlag,
  type TerminalWorkerRequest,
  type TerminalWorkerResponse,
} from "./terminal-worker-protocol.js";

interface WorkerTransport {
  post(message: TerminalWorkerResponse): void;
  onRequest(listener: (request: TerminalWorkerRequest) => void): void;
  onDisconnect(listener: () => void): void;
}

// Inside Electron the worker is a utility process and talks to the main
// process over its MessagePort. Inside WSL it is a plain Node.js process
// started by wsl.exe and talks over stdio, one JSON message per line.
function createTransport(): WorkerTransport {
  const parentPort = process.parentPort;
  if (parentPort) {
    return {
      post: (message) => parentPort.postMessage(message),
      onRequest: (listener) => {
        parentPort.on("message", (event) => {
          listener(event.data as TerminalWorkerRequest);
        });
      },
      onDisconnect: () => undefined,
    };
  }
  if (!process.argv.includes(stdioTransportFlag)) {
    throw new Error(
      `Terminal worker must be launched as an Electron utility process or with ${stdioTransportFlag}`,
    );
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return {
    post: (message) => {
      process.stdout.write(encodeStdioMessage(message));
    },
    onRequest: (listener) => {
      lines.on("line", (line) => {
        if (!line.trim()) {
          return;
        }
        listener(JSON.parse(line) as TerminalWorkerRequest);
      });
    },
    onDisconnect: (listener) => {
      lines.on("close", listener);
    },
  };
}

const transport = createTransport();
const terminals = new Map<string, pty.IPty>();
const executeFile = promisify(execFile);
let isolation: PreparedIsolation["execution"] | undefined;
let shuttingDown = false;
let emptyWaiter: (() => void) | undefined;

function post(message: TerminalWorkerResponse): void {
  transport.post(message);
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

  // The worker runs where the capsule executes, so the agent command is
  // resolved against the capsule PATH on this filesystem.
  const requested = request.verifyExecutable
    ? await prepareAgentLaunch(request.launchSpec)
    : request.launchSpec;
  if (request.verifyExecutable && isolation.backend === "sandbox-runtime") {
    const probe = await wrapSandboxedLaunch(
      {
        command: "/bin/test",
        args: ["-x", requested.command],
        cwd: requested.cwd,
        env: requested.env,
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
        `Agent command '${requested.command}' exists but is not reachable inside this target's sandbox`,
      );
    } finally {
      cleanupSandboxCommand();
    }
  }
  const launchSpec = isolation.backend === "sandbox-runtime"
    ? await wrapSandboxedLaunch(requested, request.terminalId)
    : requested;
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

transport.onRequest((request) => {
  void handle(request).catch((error: unknown) => {
    post({ type: "fatal-error", message: errorMessage(error) });
    void shutdown().finally(() => process.exit(1));
  });
});

// Losing the control channel means the main process is gone; never leave
// capsule processes running unattended.
transport.onDisconnect(() => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

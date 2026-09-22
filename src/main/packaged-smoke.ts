import { platform } from "node:os";
import type { UtilityProcess } from "electron";
import { utilityProcess } from "electron";
import {
  isTerminalWorkerResponse,
  type TerminalWorkerRequest,
} from "./terminal-worker-protocol.js";

const expectedOutput = "opscapsule-packaged-worker-ok";

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export function verifyPackagedTerminalWorker(
  workerPath: string,
  cwd: string,
): Promise<void> {
  const environment = processEnvironment();

  return new Promise((resolve, reject) => {
    let worker: UtilityProcess | undefined;
    let output = "";
    let terminalPassed = false;
    let settled = false;

    const timer = setTimeout(() => {
      fail(new Error("Packaged terminal worker verification timed out"));
    }, 15_000);

    function fail(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker?.kill();
      reject(error);
    }

    worker = utilityProcess.fork(workerPath, [], {
      cwd,
      env: environment,
      stdio: "pipe",
      serviceName: "OpsCapsule Packaged Terminal Verification",
    });

    worker.stderr?.on("data", (data: Buffer | string) => {
      process.stderr.write(data);
    });
    worker.on("spawn", () => {
      worker?.postMessage({
        type: "initialize",
        isolation: { backend: "none" },
      } satisfies TerminalWorkerRequest);
    });
    worker.on("message", (message: unknown) => {
      if (!isTerminalWorkerResponse(message)) {
        return;
      }
      if (message.type === "ready") {
        const windows = platform() === "win32";
        worker?.postMessage({
          type: "start-terminal",
          terminalId: "packaged-verification",
          verifyExecutable: false,
          launchSpec: {
            command: windows ? "cmd.exe" : "/bin/sh",
            args: windows
              ? ["/d", "/s", "/c", `echo ${expectedOutput}`]
              : ["-lc", `printf '${expectedOutput}\\n'`],
            cwd,
            env: environment,
          },
          cols: 80,
          rows: 24,
        } satisfies TerminalWorkerRequest);
        return;
      }
      if (message.type === "terminal-data") {
        output += message.data;
        return;
      }
      if (message.type === "terminal-error" || message.type === "fatal-error") {
        fail(new Error(message.message));
        return;
      }
      if (message.type === "terminal-exit") {
        if (message.exitCode !== 0 || !output.includes(expectedOutput)) {
          fail(
            new Error(
              `Unexpected packaged terminal result (${message.exitCode}): ${JSON.stringify(output)}`,
            ),
          );
          return;
        }
        terminalPassed = true;
        worker?.postMessage({
          type: "shutdown",
        } satisfies TerminalWorkerRequest);
      }
    });
    worker.on("error", (_type, location, report) => {
      fail(
        new Error(`Packaged terminal worker failed at ${location}: ${report}`),
      );
    });
    worker.on("exit", (exitCode) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      if (!terminalPassed || exitCode !== 0) {
        fail(
          new Error(
            `Packaged terminal worker exited unexpectedly with code ${exitCode}`,
          ),
        );
        return;
      }
      settled = true;
      resolve();
    });
  });
}

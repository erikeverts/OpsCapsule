import type { PreparedIsolation } from "./isolation/types.js";
import type { ProcessLaunchSpec } from "./runtime-adapters/types.js";

export type TerminalWorkerRequest =
  | {
      type: "initialize";
      isolation: PreparedIsolation["execution"];
    }
  | {
      type: "start-terminal";
      terminalId: string;
      launchSpec: ProcessLaunchSpec;
      verifyExecutable: boolean;
      cols: number;
      rows: number;
    }
  | { type: "write"; terminalId: string; data: string }
  | { type: "resize"; terminalId: string; cols: number; rows: number }
  | { type: "kill-terminal"; terminalId: string }
  | { type: "shutdown" };

export type TerminalWorkerResponse =
  | { type: "ready" }
  | { type: "terminal-started"; terminalId: string }
  | { type: "terminal-data"; terminalId: string; data: string }
  | { type: "terminal-exit"; terminalId: string; exitCode: number }
  | { type: "terminal-error"; terminalId: string; message: string }
  | { type: "fatal-error"; message: string };

export function isTerminalWorkerResponse(
  value: unknown,
): value is TerminalWorkerResponse {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  return typeof value.type === "string" && [
    "ready",
    "terminal-started",
    "terminal-data",
    "terminal-exit",
    "terminal-error",
    "fatal-error",
  ].includes(value.type);
}

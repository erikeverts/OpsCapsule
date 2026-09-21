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

// When the worker runs outside Electron (inside WSL under Node.js), messages
// travel as JSON lines over stdio. Responses carry this prefix so login-shell
// noise on stdout is never mistaken for protocol traffic.
export const stdioMessageMarker = "OPSCAPSULE_MESSAGE ";
export const stdioTransportFlag = "--stdio";

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

export function encodeStdioMessage(message: TerminalWorkerResponse): string {
  return `${stdioMessageMarker}${JSON.stringify(message)}\n`;
}

// Returns the response embedded in a stdout line, or undefined for a line
// that does not carry one.
export function decodeStdioMessage(line: string): TerminalWorkerResponse | undefined {
  const start = line.lastIndexOf(stdioMessageMarker);
  if (start < 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(
      line.slice(start + stdioMessageMarker.length).trim(),
    );
    return isTerminalWorkerResponse(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

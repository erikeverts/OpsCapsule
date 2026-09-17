import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type {
  RuntimePaths,
  TerminalDataEvent,
  TerminalDescriptor,
  TerminalExitEvent,
  WorkspaceDefinition,
  WorkspaceSession,
} from "../shared/contracts.js";
import { CommandRuntimeAdapter } from "./runtime-adapters/command.js";
import type { ProcessLaunchSpec } from "./runtime-adapters/types.js";
import { buildWorkspaceEnvironment } from "./runtime-directory.js";

interface TerminalRecord {
  sessionId: string;
  process: pty.IPty;
}

interface TerminalEvents {
  data: (event: TerminalDataEvent) => void;
  exit: (event: TerminalExitEvent) => void;
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly sessions = new Map<string, Set<string>>();

  constructor(private readonly events: TerminalEvents) {}

  startWorkspace(
    workspace: WorkspaceDefinition,
    runtime: RuntimePaths,
  ): WorkspaceSession {
    const sessionId = randomUUID();
    const environment = buildWorkspaceEnvironment(runtime, workspace);
    const shellDefinition = {
      adapter: "command" as const,
      command: "$SHELL",
      args: [] as string[],
    };
    const terminals: TerminalDescriptor[] = [
      { id: randomUUID(), title: "Agent", kind: "agent" },
      { id: randomUUID(), title: "Shell A", kind: "shell" },
      { id: randomUUID(), title: "Shell B", kind: "shell" },
    ];

    this.sessions.set(sessionId, new Set());

    for (const terminal of terminals) {
      const definition =
        terminal.kind === "agent" ? workspace.agentRuntime : shellDefinition;
      const adapter = new CommandRuntimeAdapter(definition);
      const launchSpec = adapter.buildLaunchSpec({
        workspace,
        runtime,
        environment,
        role: terminal.kind,
      });
      this.spawnTerminal(sessionId, terminal.id, launchSpec);
    }

    return { id: sessionId, workspace, runtime, terminals };
  }

  write(sessionId: string, terminalId: string, data: string): void {
    this.getTerminal(sessionId, terminalId).process.write(data);
  }

  resize(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): void {
    this.getTerminal(sessionId, terminalId).process.resize(cols, rows);
  }

  stopSession(sessionId: string): void {
    const terminalIds = this.sessions.get(sessionId);
    if (!terminalIds) {
      return;
    }

    for (const terminalId of terminalIds) {
      this.terminals.get(terminalId)?.process.kill();
      this.terminals.delete(terminalId);
    }
    this.sessions.delete(sessionId);
  }

  stopAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.stopSession(sessionId);
    }
  }

  private spawnTerminal(
    sessionId: string,
    terminalId: string,
    launchSpec: ProcessLaunchSpec,
  ): void {
    const process = pty.spawn(launchSpec.command, launchSpec.args, {
      name: "xterm-256color",
      cols: 100,
      rows: 28,
      cwd: launchSpec.cwd,
      env: launchSpec.env,
    });

    this.terminals.set(terminalId, { sessionId, process });
    this.sessions.get(sessionId)?.add(terminalId);

    process.onData((data) => {
      this.events.data({ sessionId, terminalId, data });
    });
    process.onExit(({ exitCode }) => {
      this.events.exit({ sessionId, terminalId, exitCode });
      this.terminals.delete(terminalId);
      this.sessions.get(sessionId)?.delete(terminalId);
    });
  }

  private getTerminal(sessionId: string, terminalId: string): TerminalRecord {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.sessionId !== sessionId) {
      throw new Error("Terminal does not belong to this workspace session");
    }
    return terminal;
  }
}


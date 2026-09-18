import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type {
  RuntimePaths,
  TerminalDataEvent,
  TerminalDescriptor,
  TerminalExitEvent,
  WorkspaceSession,
} from "../shared/contracts.js";
import type { ExecutionHost } from "./hosts/types.js";
import type { PreparedIsolation } from "./isolation/types.js";
import { CommandRuntimeAdapter } from "./runtime-adapters/command.js";
import type { ProcessLaunchSpec } from "./runtime-adapters/types.js";
import type { CapsuleRuntime } from "./runtime-directory.js";
import type { ResolvedWorkspaceTarget } from "./workspace-registry.js";

interface TerminalRecord {
  sessionId: string;
  process: pty.IPty;
  attached: boolean;
  pendingData: string;
}

interface SessionRecord {
  terminalIds: Set<string>;
  runtime: RuntimePaths;
}

interface TerminalEvents {
  data: (event: TerminalDataEvent) => void;
  exit: (event: TerminalExitEvent) => void;
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly host: ExecutionHost,
    private readonly events: TerminalEvents,
  ) {}

  createSessionId(): string {
    return randomUUID();
  }

  async startWorkspace(
    sessionId: string,
    resolvedTarget: ResolvedWorkspaceTarget,
    capsule: CapsuleRuntime,
    isolation: PreparedIsolation,
  ): Promise<WorkspaceSession> {
    const { runtime, environment, workingDirectory: cwd } = capsule;
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

    this.sessions.set(sessionId, { terminalIds: new Set(), runtime });

    try {
      for (const terminal of terminals) {
        const definition =
          terminal.kind === "agent"
            ? resolvedTarget.target.agentRuntime
            : shellDefinition;
        const adapter = new CommandRuntimeAdapter(definition);
        const launchSpec = adapter.buildLaunchSpec({
          runtime,
          environment,
          role: terminal.kind,
          cwd,
        });
        this.spawnTerminal(
          sessionId,
          terminal.id,
          isolation.wrap(launchSpec),
        );
      }
    } catch (error) {
      await this.stopSession(sessionId);
      throw error;
    }

    return {
      id: sessionId,
      workspace: {
        id: resolvedTarget.workspace.manifest.metadata.id,
        name: resolvedTarget.workspace.manifest.metadata.name,
      },
      target: resolvedTarget.summary,
      runtime,
      isolation: isolation.effective,
      host: { id: this.host.id, label: this.host.label },
      terminals,
    };
  }

  write(sessionId: string, terminalId: string, data: string): void {
    this.getTerminal(sessionId, terminalId).process.write(data);
  }

  attach(sessionId: string, terminalId: string): void {
    const terminal = this.getTerminal(sessionId, terminalId);
    if (terminal.attached) {
      return;
    }

    terminal.attached = true;
    if (terminal.pendingData) {
      this.events.data({
        sessionId,
        terminalId,
        data: terminal.pendingData,
      });
      terminal.pendingData = "";
    }
  }

  resize(
    sessionId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ): void {
    this.getTerminal(sessionId, terminalId).process.resize(cols, rows);
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    for (const terminalId of session.terminalIds) {
      this.terminals.get(terminalId)?.process.kill();
      this.terminals.delete(terminalId);
    }
    this.sessions.delete(sessionId);
    await this.host.cleanupRuntime(session.runtime);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((sessionId) => this.stopSession(sessionId)),
    );
  }

  private spawnTerminal(
    sessionId: string,
    terminalId: string,
    launchSpec: ProcessLaunchSpec,
  ): void {
    const launch = this.host.launch(launchSpec);
    const process = pty.spawn(launch.file, launch.args, {
      name: "xterm-256color",
      cols: 100,
      rows: 28,
      cwd: launch.cwd,
      env: launch.env,
    });

    const terminalRecord: TerminalRecord = {
      sessionId,
      process,
      attached: false,
      pendingData: "",
    };
    this.terminals.set(terminalId, terminalRecord);
    this.sessions.get(sessionId)?.terminalIds.add(terminalId);

    process.onData((data) => {
      if (terminalRecord.attached) {
        this.events.data({ sessionId, terminalId, data });
      } else {
        terminalRecord.pendingData += data;
      }
    });
    process.onExit(({ exitCode }) => {
      this.events.exit({ sessionId, terminalId, exitCode });
      this.terminals.delete(terminalId);
      this.sessions.get(sessionId)?.terminalIds.delete(terminalId);
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

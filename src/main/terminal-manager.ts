import { randomUUID } from "node:crypto";
import type {
  RuntimePaths,
  TerminalDataEvent,
  TerminalDescriptor,
  TerminalExitEvent,
  WorkspaceSession,
} from "../shared/contracts.js";
import type { ExecutionHost, TerminalWorkerProcess } from "./hosts/types.js";
import type { PreparedIsolation } from "./isolation/types.js";
import { CommandRuntimeAdapter } from "./runtime-adapters/command.js";
import { RuntimeAdapterRegistry } from "./runtime-adapters/registry.js";
import type { ProcessLaunchSpec } from "./runtime-adapters/types.js";
import type { CapsuleRuntime } from "./runtime-directory.js";
import {
  isTerminalWorkerResponse,
  type TerminalWorkerRequest,
  type TerminalWorkerResponse,
} from "./terminal-worker-protocol.js";
import type { ResolvedWorkspaceTarget } from "./workspace-registry.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

interface TerminalRecord {
  sessionId: string;
  attached: boolean;
  pendingData: string;
}

interface SessionRecord {
  workspaceId: string;
  terminalIds: Set<string>;
  runtime: RuntimePaths;
  worker: TerminalWorkerProcess;
  workerReady: Deferred<void>;
  workerExit: Deferred<number>;
  pendingStarts: Map<string, Deferred<void>>;
  workerState: "starting" | "ready" | "stopping" | "exited";
  diagnostics: string;
}

interface TerminalEvents {
  data: (event: TerminalDataEvent) => void;
  exit: (event: TerminalExitEvent) => void;
}

interface TerminalManagerOptions {
  host: ExecutionHost;
  events: TerminalEvents;
  runtimeAdapters?: RuntimeAdapterRegistry;
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly host: ExecutionHost;
  private readonly events: TerminalEvents;
  private readonly runtimeAdapters: RuntimeAdapterRegistry;

  constructor(options: TerminalManagerOptions) {
    this.host = options.host;
    this.events = options.events;
    this.runtimeAdapters = options.runtimeAdapters ?? new RuntimeAdapterRegistry();
  }

  createSessionId(): string {
    return randomUUID();
  }

  hasActiveWorkspace(workspaceId: string): boolean {
    return [...this.sessions.values()].some(
      (session) => session.workspaceId === workspaceId,
    );
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
      {
        id: randomUUID(),
        title: `Agent · ${resolvedTarget.agent.profile.name}`,
        kind: "agent",
      },
      { id: randomUUID(), title: "Shell A", kind: "shell" },
      { id: randomUUID(), title: "Shell B", kind: "shell" },
    ];

    const worker = this.host.forkTerminalWorker({ cwd, env: environment });
    const session: SessionRecord = {
      workspaceId: resolvedTarget.workspace.manifest.metadata.id,
      terminalIds: new Set(),
      runtime,
      worker,
      workerReady: deferred<void>(),
      workerExit: deferred<number>(),
      pendingStarts: new Map(),
      workerState: "starting",
      diagnostics: "",
    };
    this.sessions.set(sessionId, session);
    this.bindWorker(sessionId, session, isolation);

    try {
      await withTimeout(
        session.workerReady.promise,
        30_000,
        "Timed out while initializing the terminal worker",
      );
      for (const terminal of terminals) {
        const adapter = terminal.kind === "agent"
          ? this.runtimeAdapters.createAgent(resolvedTarget.agent)
          : new CommandRuntimeAdapter(shellDefinition);
        // The worker resolves and probes the agent executable itself: it
        // runs on the execution host, which owns the capsule filesystem.
        await this.spawnTerminal(
          sessionId,
          terminal.id,
          adapter.buildLaunchSpec({
            runtime,
            environment,
            role: terminal.kind,
            cwd,
          }),
          terminal.kind === "agent",
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
    this.getTerminal(sessionId, terminalId);
    this.postToWorker(sessionId, { type: "write", terminalId, data });
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
    this.getTerminal(sessionId, terminalId);
    this.postToWorker(sessionId, { type: "resize", terminalId, cols, rows });
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.workerState = "stopping";
    try {
      session.worker.postMessage(
        { type: "shutdown" } satisfies TerminalWorkerRequest,
      );
      await withTimeout(
        session.workerExit.promise,
        3_000,
        "Timed out while stopping the terminal worker",
      );
    } catch {
      session.worker.kill();
    }
    for (const terminalId of session.terminalIds) {
      this.terminals.delete(terminalId);
    }
    session.pendingStarts.forEach((pending) => {
      pending.reject(new Error("Terminal worker stopped before launch completed"));
    });
    this.sessions.delete(sessionId);
    await this.host.cleanupRuntime(session.runtime);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((sessionId) => this.stopSession(sessionId)),
    );
  }

  private bindWorker(
    sessionId: string,
    session: SessionRecord,
    isolation: PreparedIsolation,
  ): void {
    session.worker.stdout?.resume();
    session.worker.stderr?.on("data", (chunk: Buffer | string) => {
      session.diagnostics = `${session.diagnostics}${String(chunk)}`.slice(-8_192);
    });
    session.worker.on("spawn", () => {
      session.worker.postMessage({
        type: "initialize",
        isolation: isolation.execution,
      } satisfies TerminalWorkerRequest);
    });
    session.worker.on("message", (message: unknown) => {
      if (isTerminalWorkerResponse(message)) {
        this.handleWorkerMessage(sessionId, session, message);
      }
    });
    session.worker.on("error", (_type, location, report) => {
      this.failWorker(
        sessionId,
        session,
        new Error(`Terminal worker failed at ${location}: ${report}`),
      );
    });
    session.worker.on("exit", (exitCode) => {
      const exitedBeforeReady = session.workerState === "starting";
      if (exitedBeforeReady || exitCode !== 0 || session.terminalIds.size > 0) {
        const diagnostics = session.diagnostics.trim();
        this.failWorker(
          sessionId,
          session,
          new Error(
            `Terminal worker exited with code ${exitCode}${diagnostics ? `: ${diagnostics}` : ""}`,
          ),
        );
      }
      session.workerState = "exited";
      session.workerExit.resolve(exitCode);
    });
  }

  private handleWorkerMessage(
    sessionId: string,
    session: SessionRecord,
    message: TerminalWorkerResponse,
  ): void {
    switch (message.type) {
      case "ready":
        session.workerState = "ready";
        session.workerReady.resolve();
        return;
      case "terminal-started":
        session.pendingStarts.get(message.terminalId)?.resolve();
        session.pendingStarts.delete(message.terminalId);
        return;
      case "terminal-data": {
        const terminal = this.terminals.get(message.terminalId);
        if (!terminal || terminal.sessionId !== sessionId) {
          return;
        }
        if (terminal.attached) {
          this.events.data({
            sessionId,
            terminalId: message.terminalId,
            data: message.data,
          });
        } else {
          terminal.pendingData += message.data;
        }
        return;
      }
      case "terminal-exit":
        this.finishTerminal(
          sessionId,
          session,
          message.terminalId,
          message.exitCode,
        );
        return;
      case "terminal-error": {
        const error = new Error(message.message);
        session.pendingStarts.get(message.terminalId)?.reject(error);
        session.pendingStarts.delete(message.terminalId);
        this.finishTerminal(sessionId, session, message.terminalId, 1);
        return;
      }
      case "fatal-error":
        this.failWorker(sessionId, session, new Error(message.message));
    }
  }

  private failWorker(
    sessionId: string,
    session: SessionRecord,
    error: Error,
  ): void {
    if (session.workerState === "starting") {
      session.workerReady.reject(error);
    }
    for (const [terminalId, pending] of session.pendingStarts) {
      pending.reject(error);
      this.finishTerminal(sessionId, session, terminalId, 1);
    }
    session.pendingStarts.clear();
    for (const terminalId of [...session.terminalIds]) {
      this.finishTerminal(sessionId, session, terminalId, 1);
    }
  }

  private finishTerminal(
    sessionId: string,
    session: SessionRecord,
    terminalId: string,
    exitCode: number,
  ): void {
    if (!this.terminals.has(terminalId)) {
      return;
    }
    this.events.exit({ sessionId, terminalId, exitCode });
    this.terminals.delete(terminalId);
    session.terminalIds.delete(terminalId);
  }

  private async spawnTerminal(
    sessionId: string,
    terminalId: string,
    launchSpec: ProcessLaunchSpec,
    verifyExecutable: boolean,
  ): Promise<void> {
    const session = this.getSession(sessionId);
    const pending = deferred<void>();
    session.pendingStarts.set(terminalId, pending);
    session.terminalIds.add(terminalId);
    this.terminals.set(terminalId, {
      sessionId,
      attached: false,
      pendingData: "",
    });
    session.worker.postMessage({
      type: "start-terminal",
      terminalId,
      launchSpec,
      verifyExecutable,
      cols: 100,
      rows: 28,
    } satisfies TerminalWorkerRequest);
    await withTimeout(
      pending.promise,
      15_000,
      "Timed out while starting a terminal",
    );
  }

  private postToWorker(sessionId: string, message: TerminalWorkerRequest): void {
    this.getSession(sessionId).worker.postMessage(message);
  }

  private getSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Workspace session is not active");
    }
    return session;
  }

  private getTerminal(sessionId: string, terminalId: string): TerminalRecord {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.sessionId !== sessionId) {
      throw new Error("Terminal does not belong to this workspace session");
    }
    return terminal;
  }
}

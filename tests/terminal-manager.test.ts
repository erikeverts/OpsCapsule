import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UtilityProcess } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import { ContextOnlyIsolation } from "../src/main/isolation/context-only.js";
import { createWorkspaceRuntime } from "../src/main/runtime-directory.js";
import { TerminalManager } from "../src/main/terminal-manager.js";
import type {
  TerminalWorkerRequest,
  TerminalWorkerResponse,
} from "../src/main/terminal-worker-protocol.js";
import { WorkspaceRegistry } from "../src/main/workspace-registry.js";

const temporaryDirectories: string[] = [];

class FakeUtilityProcess extends EventEmitter {
  readonly messages: TerminalWorkerRequest[] = [];
  readonly stdout = null;
  readonly stderr = null;
  pid: number | undefined = 1234;

  postMessage(message: TerminalWorkerRequest): void {
    this.messages.push(message);
    queueMicrotask(() => {
      if (message.type === "initialize") {
        this.respond({ type: "ready" });
      } else if (message.type === "start-terminal") {
        this.respond({
          type: "terminal-started",
          terminalId: message.terminalId,
        });
      } else if (message.type === "shutdown") {
        for (const terminal of this.messages.filter(
          (candidate): candidate is Extract<
            TerminalWorkerRequest,
            { type: "start-terminal" }
          > => candidate.type === "start-terminal",
        )) {
          this.respond({
            type: "terminal-exit",
            terminalId: terminal.terminalId,
            exitCode: 0,
          });
        }
        this.pid = undefined;
        this.emit("exit", 0);
      }
    });
  }

  kill(): boolean {
    this.pid = undefined;
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }

  respond(message: TerminalWorkerResponse): void {
    this.emit("message", message);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("terminal utility-process orchestration", () => {
  it("uses one fixed worker for all capsule terminals and forwards terminal traffic", async () => {
    const base = await mkdtemp(join(tmpdir(), "opscapsule-terminal-worker-"));
    temporaryDirectories.push(base);
    const registry = new WorkspaceRegistry(base);
    await registry.initialize();
    const target = await registry.resolveTarget("atlas", "development");
    const runtime = await createWorkspaceRuntime(base, "worker-session", target);
    const workers: FakeUtilityProcess[] = [];
    const dataEvents: Array<{ terminalId: string; data: string }> = [];
    const manager = new TerminalManager({
      events: {
        data: ({ terminalId, data }) => dataEvents.push({ terminalId, data }),
        exit: () => undefined,
      },
      workerPath: "/fixed/application/terminal-worker.cjs",
      forkWorker: () => {
        const worker = new FakeUtilityProcess();
        workers.push(worker);
        queueMicrotask(() => worker.emit("spawn"));
        return worker as unknown as UtilityProcess;
      },
    });

    const session = await manager.startWorkspace(
      "worker-session",
      target,
      runtime,
      new ContextOnlyIsolation([], [runtime.root], "deny"),
    );

    expect(workers).toHaveLength(1);
    expect(
      workers[0]!.messages.filter(({ type }) => type === "start-terminal"),
    ).toHaveLength(3);
    expect(
      workers[0]!.messages
        .filter((message): message is Extract<
          TerminalWorkerRequest,
          { type: "start-terminal" }
        > => message.type === "start-terminal")
        .map(({ verifyExecutable }) => verifyExecutable),
    ).toEqual([true, false, false]);
    expect(workers[0]!.messages[0]).toEqual({
      type: "initialize",
      isolation: { backend: "none" },
    });

    const terminalId = session.terminals[0]!.id;
    manager.attach(session.id, terminalId);
    workers[0]!.respond({
      type: "terminal-data",
      terminalId,
      data: "ready\r\n",
    });
    manager.write(session.id, terminalId, "status\r");
    manager.resize(session.id, terminalId, 132, 40);

    expect(dataEvents).toEqual([{ terminalId, data: "ready\r\n" }]);
    expect(workers[0]!.messages).toContainEqual({
      type: "write",
      terminalId,
      data: "status\r",
    });
    expect(workers[0]!.messages).toContainEqual({
      type: "resize",
      terminalId,
      cols: 132,
      rows: 40,
    });

    await manager.stopSession(session.id);
    expect(workers[0]!.messages.at(-1)).toEqual({ type: "shutdown" });
  });
});

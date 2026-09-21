import { homedir } from "node:os";
import { join } from "node:path";
import { createDemoDirectories } from "../default-workspaces.js";
import { prepareIsolation } from "../isolation/prepare.js";
import { inspectDirectory } from "../local-resources.js";
import {
  cleanupStaleWorkspaceRuntimes,
  cleanupWorkspaceRuntime,
  createCapsuleRuntime,
  deleteWorkspaceState,
} from "../runtime-directory.js";
import { checkTargetReadiness } from "../target-readiness.js";
import {
  resultMarker,
  wslHelperCommands,
  type WslHelperCommand,
  type WslHelperRequests,
  type WslHelperResponses,
  type WslHelperResult,
} from "./wsl-protocol.js";

// Executed inside the WSL distribution. It receives one JSON request on stdin
// and prints one marked JSON result line, so the Linux-side runtime code runs
// unchanged where the capsule processes actually execute.

type Handlers = {
  [Command in WslHelperCommand]: (
    request: WslHelperRequests[Command],
  ) => Promise<WslHelperResponses[Command]>;
};

function stateDirectory(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  const base =
    xdgStateHome && xdgStateHome.startsWith("/")
      ? xdgStateHome
      : join(homedir(), ".local", "state");
  return join(base, "opscapsule");
}

const handlers: Handlers = {
  probe: async () => {
    if (process.platform !== "linux") {
      throw new Error(`Expected a Linux environment, found ${process.platform}`);
    }
    return {
      home: homedir(),
      stateDirectory: stateDirectory(),
      shell: process.env.SHELL ?? "/bin/sh",
      nodeVersion: process.version,
      distribution: process.env.WSL_DISTRO_NAME ?? "",
    };
  },
  "seed-demo": async ({ directories }) => {
    await createDemoDirectories(directories);
    return {};
  },
  "inspect-directory": ({ path }) => inspectDirectory(path),
  "cleanup-stale": async ({ baseDirectory }) => {
    await cleanupStaleWorkspaceRuntimes(baseDirectory);
    return {};
  },
  "delete-workspace-state": async ({ baseDirectory, workspaceId }) => {
    await deleteWorkspaceState(baseDirectory, workspaceId);
    return {};
  },
  "check-readiness": ({ resolvedTarget }) => checkTargetReadiness(resolvedTarget),
  "create-runtime": async ({ baseDirectory, sessionId, resolvedTarget }) => {
    const capsule = await createCapsuleRuntime(
      baseDirectory,
      sessionId,
      resolvedTarget,
    );
    if (!capsule.environment.SHELL) {
      capsule.environment.SHELL = "/bin/sh";
    }
    return capsule;
  },
  "cleanup-runtime": async ({ runtime }) => {
    await cleanupWorkspaceRuntime(runtime);
    return {};
  },
  // PreparedIsolation is plain data, so the result serialises as-is.
  "prepare-isolation": async ({ runtime, resolvedTarget }) => {
    const isolation = await prepareIsolation(runtime, resolvedTarget);
    return { effective: isolation.effective, execution: isolation.execution };
  },
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isCommand(value: string | undefined): value is WslHelperCommand {
  return wslHelperCommands.includes(value as WslHelperCommand);
}

function emit(result: WslHelperResult<WslHelperCommand>): void {
  process.stdout.write(`${resultMarker}${JSON.stringify(result)}\n`);
}

async function run(): Promise<void> {
  const command = process.argv[2];
  if (!isCommand(command)) {
    throw new Error(`Unknown helper command '${command ?? ""}'`);
  }
  const input = await readStdin();
  const request = (input.trim() ? JSON.parse(input) : {}) as never;
  const value = await handlers[command](request);
  emit({ ok: true, value });
}

run().catch((error: unknown) => {
  emit({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

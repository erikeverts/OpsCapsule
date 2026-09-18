import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  type SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";
import { allowsPublicDestination } from "./public-network.js";

type NetworkMode = "public" | "deny" | "allowlist";

interface RunnerArguments {
  settingsPath: string;
  networkMode: NetworkMode;
  command: string[];
}

function parseArguments(argv: string[]): RunnerArguments {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error("Expected a command after --");
  }

  const options = argv.slice(0, separator);
  const settingsIndex = options.indexOf("--settings");
  const networkModeIndex = options.indexOf("--network-mode");
  const settingsPath = options[settingsIndex + 1];
  const networkMode = options[networkModeIndex + 1];

  if (settingsIndex < 0 || !settingsPath) {
    throw new Error("Missing --settings path");
  }
  if (
    networkModeIndex < 0 ||
    !["public", "deny", "allowlist"].includes(networkMode ?? "")
  ) {
    throw new Error("Missing or invalid --network-mode");
  }

  return {
    settingsPath,
    networkMode: networkMode as NetworkMode,
    command: argv.slice(separator + 1),
  };
}

function quoteForPosixShell(argument: string): string {
  return `'${argument.split("'").join("'\\''")}'`;
}

async function run(): Promise<void> {
  if (process.platform === "win32") {
    throw new Error(
      "The sandbox runner must execute inside a Linux (WSL) or macOS environment",
    );
  }

  const { settingsPath, networkMode, command } = parseArguments(
    process.argv.slice(2),
  );
  const settings = SandboxRuntimeConfigSchema.parse(
    JSON.parse(await readFile(settingsPath, "utf8")),
  );
  // This callback is the supported SRT escape hatch for an unmatched public
  // destination. It is never installed for deny or allowlist policies.
  const allowPublicDestination: SandboxAskCallback | undefined =
    networkMode === "public"
      ? async (destination) => allowsPublicDestination(destination)
      : undefined;

  await SandboxManager.initialize(settings, allowPublicDestination);

  const commandString = command.map(quoteForPosixShell).join(" ");
  const wrapped = await SandboxManager.wrapWithSandboxArgv(commandString);
  const executable = wrapped.argv[0];
  if (!executable) {
    throw new Error("Sandbox Runtime did not return an executable");
  }
  const child = spawn(executable, wrapped.argv.slice(1), {
    cwd: process.cwd(),
    env: wrapped.env,
    shell: false,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    SandboxManager.cleanupAfterCommand();
    if (signal === "SIGINT" || signal === "SIGTERM") {
      process.exit(0);
    }
    if (signal) {
      console.error(`Sandboxed command was killed by ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
  child.on("error", (error) => {
    console.error(`Failed to execute sandboxed command: ${error.message}`);
    process.exit(1);
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

run().catch((error: unknown) => {
  console.error(`Sandbox runner failed: ${
    error instanceof Error ? error.message : String(error)
  }`);
  process.exit(1);
});

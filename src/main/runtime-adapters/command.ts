import type {
  ProcessLaunchSpec,
  RuntimeAdapter,
  RuntimeLaunchContext,
} from "./types.js";

interface CommandLaunchDefinition {
  adapter?: "command";
  command: string;
  args: string[];
}

function defaultShell(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return "powershell.exe";
  }
  if (platform === "darwin") {
    return "/bin/zsh";
  }
  return "/bin/bash";
}

export class CommandRuntimeAdapter implements RuntimeAdapter {
  readonly id = "command";

  constructor(
    private readonly definition: CommandLaunchDefinition,
    private readonly environment: Record<string, string> = {},
    private readonly exposeAgentState = false,
  ) {}

  buildLaunchSpec(context: RuntimeLaunchContext): ProcessLaunchSpec {
    const command =
      this.definition.command === "$SHELL"
        ? (context.environment.SHELL ?? defaultShell(process.platform))
        : this.definition.command;

    return {
      command,
      args: [...this.definition.args],
      cwd: context.cwd,
      env: {
        ...this.environment,
        ...context.environment,
        ...(this.exposeAgentState
          ? { OPSCAPSULE_AGENT_STATE: context.runtime.agentState }
          : {}),
      },
    };
  }
}

import { join } from "node:path";
import type { AgentProfile } from "../../shared/workspace-schema.js";
import type {
  ProcessLaunchSpec,
  RuntimeAdapter,
  RuntimeLaunchContext,
} from "./types.js";

const settingsDestination = ".claude/settings.json";

export class ClaudeCodeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "claude-code";

  constructor(private readonly profile: AgentProfile) {}

  buildLaunchSpec(context: RuntimeLaunchContext): ProcessLaunchSpec {
    const args = [...this.profile.runtime.args];
    const settings = this.profile.configuration.files.find(
      ({ destination }) => destination === settingsDestination,
    );
    if (
      settings &&
      !args.some(
        (argument) =>
          argument === "--settings" || argument.startsWith("--settings="),
      )
    ) {
      args.unshift(
        "--settings",
        join(context.runtime.home, ".claude", "settings.json"),
      );
    }

    return {
      command: this.profile.runtime.command,
      args,
      cwd: context.cwd,
      env: {
        ...this.profile.environment,
        ...context.environment,
        CLAUDE_CONFIG_DIR: join(context.runtime.agentState, "data", "claude"),
        OPSCAPSULE_AGENT_STATE: context.runtime.agentState,
      },
    };
  }
}

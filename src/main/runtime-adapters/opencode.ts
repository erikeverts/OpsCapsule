import { join } from "node:path";
import type { AgentProfile } from "../../shared/workspace-schema.js";
import type {
  ProcessLaunchSpec,
  RuntimeAdapter,
  RuntimeLaunchContext,
} from "./types.js";

export class OpenCodeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "opencode";

  constructor(private readonly profile: AgentProfile) {}

  buildLaunchSpec(context: RuntimeLaunchContext): ProcessLaunchSpec {
    return {
      command: this.profile.runtime.command,
      args: [...this.profile.runtime.args],
      cwd: context.cwd,
      env: {
        ...this.profile.environment,
        ...context.environment,
        XDG_DATA_HOME: join(context.runtime.agentState, "data"),
        XDG_CACHE_HOME: join(context.runtime.agentState, "cache"),
        XDG_STATE_HOME: join(context.runtime.agentState, "sessions"),
        OPSCAPSULE_AGENT_STATE: context.runtime.agentState,
      },
    };
  }
}

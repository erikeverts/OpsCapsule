import type { RuntimeAdapter } from "./types.js";
import type { ResolvedAgentProfile } from "../workspace-registry.js";
import { CommandRuntimeAdapter } from "./command.js";
import { OpenCodeRuntimeAdapter } from "./opencode.js";

export class RuntimeAdapterRegistry {
  createAgent(agent: ResolvedAgentProfile): RuntimeAdapter {
    const { profile } = agent;
    if (profile.adapter === "command") {
      return new CommandRuntimeAdapter(profile.runtime, profile.environment, true);
    }
    if (profile.adapter === "opencode") {
      return new OpenCodeRuntimeAdapter(profile);
    }
    throw new Error(
      `Agent adapter '${profile.adapter}' is not available on this installation`,
    );
  }
}

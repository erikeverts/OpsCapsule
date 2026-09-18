import { describe, expect, it } from "vitest";
import { CommandRuntimeAdapter } from "../src/main/runtime-adapters/command.js";
import { ClaudeCodeRuntimeAdapter } from "../src/main/runtime-adapters/claude-code.js";
import { OpenCodeRuntimeAdapter } from "../src/main/runtime-adapters/opencode.js";

const runtime = {
  root: "/tmp/capsule",
  home: "/tmp/capsule/home",
  temp: "/tmp/capsule/tmp",
  kubeconfig: "/tmp/capsule/kubeconfig",
  sandboxConfig: "/tmp/capsule/sandbox.json",
  targetState: "/tmp/capsule-state",
  agentState: "/tmp/capsule-state/agents/example",
};

describe("command runtime adapter", () => {
  it("resolves the user's shell without coupling to an agent SDK", () => {
    const adapter = new CommandRuntimeAdapter({
      adapter: "command",
      command: "$SHELL",
      args: [],
    });
    const launchSpec = adapter.buildLaunchSpec({
      runtime,
      environment: { SHELL: "/opt/custom-shell", AWS_PROFILE: "test" },
      role: "agent",
      cwd: "/projects/example",
    });

    expect(launchSpec.command).toBe("/opt/custom-shell");
    expect(launchSpec.cwd).toBe("/projects/example");
    expect(launchSpec.env.AWS_PROFILE).toBe("test");
  });

  it("preserves an arbitrary executable and its arguments", () => {
    const adapter = new CommandRuntimeAdapter({
      adapter: "command",
      command: "my-agent",
      args: ["--model", "provider/model"],
    });
    const launchSpec = adapter.buildLaunchSpec({
      runtime,
      environment: {},
      role: "agent",
      cwd: "/projects/example",
    });

    expect(launchSpec.command).toBe("my-agent");
    expect(launchSpec.args).toEqual(["--model", "provider/model"]);
  });
});

describe("OpenCode runtime adapter", () => {
  it("uses profile environment and target-specific XDG state", () => {
    const adapter = new OpenCodeRuntimeAdapter({
      id: "opencode-bedrock",
      name: "OpenCode on Bedrock",
      adapter: "opencode",
      runtime: { command: "opencode", args: ["--continue"] },
      configuration: { files: [] },
      environment: { MODEL_FAMILY: "example" },
    });

    const launchSpec = adapter.buildLaunchSpec({
      runtime,
      environment: { AWS_PROFILE: "development" },
      role: "agent",
      cwd: "/projects/example",
    });

    expect(launchSpec.command).toBe("opencode");
    expect(launchSpec.args).toEqual(["--continue"]);
    expect(launchSpec.env).toMatchObject({
      AWS_PROFILE: "development",
      MODEL_FAMILY: "example",
      XDG_DATA_HOME: "/tmp/capsule-state/agents/example/data",
      XDG_CACHE_HOME: "/tmp/capsule-state/agents/example/cache",
      XDG_STATE_HOME: "/tmp/capsule-state/agents/example/sessions",
      OPSCAPSULE_AGENT_STATE: "/tmp/capsule-state/agents/example",
    });
  });
});

describe("Claude Code runtime adapter", () => {
  it("uses isolated state and explicitly passes managed settings", () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      id: "claude",
      name: "Claude Code",
      adapter: "claude-code",
      runtime: { command: "claude", args: ["--model", "sonnet"] },
      configuration: {
        files: [
          {
            source: "resources/agents/claude/settings.json",
            destination: ".claude/settings.json",
          },
        ],
      },
      environment: { CLAUDE_CODE_USE_BEDROCK: "1" },
    });

    const launchSpec = adapter.buildLaunchSpec({
      runtime,
      environment: { AWS_PROFILE: "development" },
      role: "agent",
      cwd: "/projects/example",
    });

    expect(launchSpec.args).toEqual([
      "--settings",
      "/tmp/capsule/home/.claude/settings.json",
      "--model",
      "sonnet",
    ]);
    expect(launchSpec.env).toMatchObject({
      AWS_PROFILE: "development",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CONFIG_DIR: "/tmp/capsule-state/agents/example/data/claude",
      OPSCAPSULE_AGENT_STATE: "/tmp/capsule-state/agents/example",
    });
  });
});

import { describe, expect, it } from "vitest";
import { parseWorkspaceManifest } from "../src/shared/workspace-schema.js";

function manifest(): Record<string, unknown> {
  return {
    apiVersion: "opscapsule.dev/v1alpha1",
    kind: "Workspace",
    metadata: { id: "example", name: "Example" },
    cloudConnections: [],
    kubernetesContexts: [],
    directories: [
      {
        id: "project",
        name: "Project",
        path: "/tmp/project",
        access: "read-write",
      },
    ],
    targets: [
      {
        id: "development",
        name: "Development",
        environment: "development",
        risk: "development",
        directories: ["project"],
        defaultDirectory: "project",
        agentRuntime: { adapter: "command", command: "$SHELL", args: [] },
        isolation: {
          mode: "context-only",
          network: { mode: "deny", allowedDomains: [] },
        },
      },
    ],
  };
}

describe("workspace agent profile schema", () => {
  it("keeps legacy target runtimes valid", () => {
    const parsed = parseWorkspaceManifest(manifest());

    expect(parsed.agentProfiles).toEqual([]);
    expect(parsed.targets[0]?.agentRuntime?.command).toBe("$SHELL");
  });

  it("resolves profile references structurally", () => {
    const input = manifest();
    input.agentProfiles = [
      {
        id: "opencode",
        name: "OpenCode",
        adapter: "opencode",
        runtime: { command: "opencode", args: [] },
        configuration: {
          files: [
            {
              source: "resources/agents/opencode/opencode.json",
              destination: ".config/opencode/opencode.json",
            },
          ],
        },
        environment: { MODEL_FAMILY: "example" },
      },
    ];
    input.defaultAgentProfile = "opencode";
    const target = (input.targets as Array<Record<string, unknown>>)[0]!;
    delete target.agentRuntime;

    const parsed = parseWorkspaceManifest(input);

    expect(parsed.defaultAgentProfile).toBe("opencode");
    expect(parsed.targets[0]?.agentRuntime).toBeUndefined();
  });

  it("accepts portable instructions and Claude Code settings", () => {
    const input = manifest();
    input.agentInstructions = "# Workspace\n\nVerify the target before changes.\n";
    input.agentProfiles = [
      {
        id: "claude",
        name: "Claude Code",
        adapter: "claude-code",
        runtime: { command: "claude", args: [] },
        configuration: {
          files: [
            {
              source: "resources/agents/claude/settings.json",
              destination: ".claude/settings.json",
            },
          ],
        },
      },
    ];
    input.defaultAgentProfile = "claude";

    const parsed = parseWorkspaceManifest(input);

    expect(parsed.agentInstructions).toContain("Verify the target");
    expect(parsed.agentProfiles[0]?.adapter).toBe("claude-code");
  });

  it("rejects unknown profile references", () => {
    const input = manifest();
    input.defaultAgentProfile = "missing";

    expect(() => parseWorkspaceManifest(input)).toThrow(
      "unknown default agent profile 'missing'",
    );
  });

  it("does not let profiles replace target identity environment", () => {
    const input = manifest();
    input.agentProfiles = [
      {
        id: "custom",
        name: "Custom",
        adapter: "command",
        runtime: { command: "custom-agent", args: [] },
        environment: { AWS_PROFILE: "another-account" },
      },
    ];
    input.defaultAgentProfile = "custom";

    expect(() => parseWorkspaceManifest(input)).toThrow(
      "managed by OpsCapsule",
    );
  });

  it("does not let a profile replace Claude Code's isolated state directory", () => {
    const input = manifest();
    input.agentProfiles = [
      {
        id: "claude",
        name: "Claude Code",
        adapter: "claude-code",
        runtime: { command: "claude", args: [] },
        environment: { CLAUDE_CONFIG_DIR: "/tmp/shared" },
      },
    ];
    input.defaultAgentProfile = "claude";

    expect(() => parseWorkspaceManifest(input)).toThrow(
      "managed by OpsCapsule",
    );
  });

  it.each([
    ["../outside.json", "normalized relative path"],
    [".aws/config", "reserved by OpsCapsule"],
    [
      ".config/opencode/auth.json",
      "support only opencode.json and tui.json settings",
    ],
  ])("rejects unsafe OpenCode destination %s", (destination, message) => {
    const input = manifest();
    input.agentProfiles = [
      {
        id: "opencode",
        name: "OpenCode",
        adapter: "opencode",
        runtime: { command: "opencode", args: [] },
        configuration: {
          files: [{ source: "/tmp/settings.json", destination }],
        },
      },
    ];
    input.defaultAgentProfile = "opencode";

    expect(() => parseWorkspaceManifest(input)).toThrow(message);
  });

  it("rejects unsupported Claude Code configuration destinations", () => {
    const input = manifest();
    input.agentProfiles = [
      {
        id: "claude",
        name: "Claude Code",
        adapter: "claude-code",
        runtime: { command: "claude", args: [] },
        configuration: {
          files: [
            {
              source: "/tmp/credentials.json",
              destination: ".claude/.credentials.json",
            },
          ],
        },
      },
    ];
    input.defaultAgentProfile = "claude";

    expect(() => parseWorkspaceManifest(input)).toThrow(
      "Claude Code profiles support only settings.json",
    );
  });
});

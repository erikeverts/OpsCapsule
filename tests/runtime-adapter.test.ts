import { describe, expect, it } from "vitest";
import { CommandRuntimeAdapter } from "../src/main/runtime-adapters/command.js";
import type { WorkspaceDefinition } from "../src/shared/contracts.js";

const workspace: WorkspaceDefinition = {
  id: "test",
  name: "Test",
  environment: "development",
  awsProfile: "test",
  accountId: "000000000000",
  region: "eu-west-1",
  cluster: "test",
  namespace: "default",
  agentRuntime: { adapter: "command", command: "$SHELL", args: [] },
};

describe("command runtime adapter", () => {
  it("resolves the user's shell without coupling to an agent SDK", () => {
    const adapter = new CommandRuntimeAdapter(workspace.agentRuntime);
    const launchSpec = adapter.buildLaunchSpec({
      workspace,
      runtime: { root: "/tmp/capsule", kubeconfig: "/tmp/capsule/kubeconfig" },
      environment: { SHELL: "/opt/custom-shell", AWS_PROFILE: "test" },
      role: "agent",
    });

    expect(launchSpec.command).toBe("/opt/custom-shell");
    expect(launchSpec.cwd).toBe("/tmp/capsule");
    expect(launchSpec.env.AWS_PROFILE).toBe("test");
  });

  it("preserves an arbitrary executable and its arguments", () => {
    const adapter = new CommandRuntimeAdapter({
      adapter: "command",
      command: "my-agent",
      args: ["--model", "provider/model"],
    });
    const launchSpec = adapter.buildLaunchSpec({
      workspace,
      runtime: { root: "/tmp/capsule", kubeconfig: "/tmp/capsule/kubeconfig" },
      environment: {},
      role: "agent",
    });

    expect(launchSpec.command).toBe("my-agent");
    expect(launchSpec.args).toEqual(["--model", "provider/model"]);
  });
});


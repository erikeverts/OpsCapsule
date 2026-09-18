import { describe, expect, it } from "vitest";
import { CommandRuntimeAdapter } from "../src/main/runtime-adapters/command.js";

const runtime = {
  root: "/tmp/capsule",
  home: "/tmp/capsule/home",
  temp: "/tmp/capsule/tmp",
  kubeconfig: "/tmp/capsule/kubeconfig",
  sandboxConfig: "/tmp/capsule/sandbox.json",
  targetState: "/tmp/capsule-state",
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

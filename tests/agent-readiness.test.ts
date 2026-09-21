import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareAgentLaunch,
  resolveExecutable,
} from "../src/main/runtime-adapters/readiness.js";

describe("agent command readiness", () => {
  it("resolves an executable without invoking a version command", async () => {
    const command = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

    const resolved = await resolveExecutable(
      command,
      { PATH: process.env.PATH ?? "" },
      process.cwd(),
    );

    expect(isAbsolute(resolved)).toBe(true);
  });

  it("returns an absolute command after the isolation probe", async () => {
    if (process.platform === "win32") {
      return;
    }
    const launch = await prepareAgentLaunch(
      {
        command: "/bin/sh",
        args: [],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
      },
    );

    expect(isAbsolute(launch.command)).toBe(true);
  });

  it("reports a missing agent command clearly", async () => {
    await expect(
      resolveExecutable(
        "opscapsule-command-that-does-not-exist",
        { PATH: process.env.PATH ?? "" },
        process.cwd(),
      ),
    ).rejects.toThrow("was not found or is not executable");
  });
});

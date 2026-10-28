import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHostExecutablePath,
  initializeHostToolEnvironment,
  pathFromNullDelimitedEnvironment,
} from "../src/main/host-tools.js";

describe("host tool environment", () => {
  it("repairs a Finder-style macOS path with Homebrew and user-local tools", () => {
    const home = "/Users/example";
    const path = buildHostExecutablePath({
      inheritedPath: "/usr/bin:/bin:/usr/sbin:/sbin",
      homeDirectory: home,
      platform: "darwin",
    }).split(":");

    expect(path).toEqual(
      expect.arrayContaining([
        join(home, ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
      ]),
    );
  });

  it("prefers the login-shell path, expands home, removes duplicates, and rejects relative entries", () => {
    const home = "/Users/example";
    const path = buildHostExecutablePath({
      loginShellPath: "~/custom/bin:/opt/homebrew/bin:.:relative",
      inheritedPath: "/opt/homebrew/bin:/usr/bin",
      homeDirectory: home,
      platform: "darwin",
    }).split(":");

    expect(path.slice(0, 3)).toEqual([
      join(home, "custom", "bin"),
      "/opt/homebrew/bin",
      "/usr/bin",
    ]);
    expect(path.filter((entry) => entry === "/opt/homebrew/bin")).toHaveLength(1);
    expect(path).not.toContain(".");
    expect(path).not.toContain("relative");
  });

  it("extracts PATH without importing noisy shell output or other variables", () => {
    const output = Buffer.from(
      "startup message\nUSER=example\0PATH=/custom/bin:/usr/bin\0SECRET=nope\0",
    );
    expect(pathFromNullDelimitedEnvironment(output)).toBe(
      "/custom/bin:/usr/bin",
    );
  });

  it("updates only PATH after login-shell discovery", async () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      KEEP: "unchanged",
    };
    const path = await initializeHostToolEnvironment({
      environment,
      homeDirectory: "/Users/example",
      platform: "darwin",
      loadLoginShellPath: async () => "/custom/bin:/usr/bin",
    });

    expect(environment).toEqual({ PATH: path, KEEP: "unchanged" });
    expect(path.split(delimiter)[0]).toBe("/custom/bin");
  });
});

import { describe, expect, it } from "vitest";
import {
  describeSandboxFailure,
  explainProbeFailure,
} from "../src/main/isolation/sandbox-diagnostics.js";

describe("explaining why a sandbox probe failed", () => {
  it("prefers what the process printed over the wrapper's exit code", () => {
    // The wrapper only ever reports "Command failed", which names nothing.
    const error = Object.assign(new Error("Command failed: /bin/test"), {
      stderr: "bwrap: setting up uid map: Permission denied\n",
    });
    expect(explainProbeFailure(error)).toBe(
      "bwrap: setting up uid map: Permission denied",
    );
  });

  it("falls back to the message when nothing was printed", () => {
    const error = Object.assign(new Error("Command failed"), { stderr: "   " });
    expect(explainProbeFailure(error)).toBe("Command failed");
  });

  it("survives something thrown that is not an error", () => {
    expect(explainProbeFailure("exploded")).toBe("exploded");
  });
});

describe("naming the cause of a sandbox that will not start", () => {
  it("names user namespaces on Linux, since the raw error does not", () => {
    const explained = describeSandboxFailure(
      "bwrap: setting up uid map: Permission denied",
      "linux",
    );
    expect(explained).toContain("unprivileged user namespaces");
    expect(explained).toContain("docs/windows-wsl.md");
    // The original evidence has to survive, or the diagnosis cannot be checked.
    expect(explained).toContain("setting up uid map");
  });

  it("does not blame namespaces for a bare permission error", () => {
    // Permission errors have many causes. A host where bubblewrap demonstrably
    // works would be sent to loosen a security setting for nothing.
    const explained = describeSandboxFailure(
      "bwrap: Can't bind mount: Operation not permitted",
      "linux",
    );
    expect(explained).not.toContain("unprivileged user namespaces");
  });

  it("does not guess at namespaces for unrelated failures", () => {
    const explained = describeSandboxFailure("bwrap: No such file or directory", "linux");
    expect(explained).toBe("bwrap: No such file or directory");
  });

  it("does not blame user namespaces on platforms that have none", () => {
    const explained = describeSandboxFailure("clone failed", "darwin");
    expect(explained).not.toContain("unprivileged user namespaces");
  });
});

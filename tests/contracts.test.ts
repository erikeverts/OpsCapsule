import { describe, expect, it } from "vitest";
import {
  startWorkspaceInput,
  terminalResizeInput,
} from "../src/shared/contracts.js";

describe("IPC contracts", () => {
  it("accepts a bounded terminal resize", () => {
    expect(
      terminalResizeInput.parse({
        sessionId: "session",
        terminalId: "terminal",
        cols: 120,
        rows: 40,
      }),
    ).toEqual({
      sessionId: "session",
      terminalId: "terminal",
      cols: 120,
      rows: 40,
    });
  });

  it("rejects malformed renderer input", () => {
    expect(() =>
      startWorkspaceInput.parse({ workspaceId: "", targetId: "development" }),
    ).toThrow();
    expect(() =>
      startWorkspaceInput.parse({ workspaceId: "atlas", targetId: "" }),
    ).toThrow();
    expect(() =>
      terminalResizeInput.parse({
        sessionId: "session",
        terminalId: "terminal",
        cols: -1,
        rows: 40,
      }),
    ).toThrow();
  });
});

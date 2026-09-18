import { describe, expect, it } from "vitest";
import {
  deleteWorkspaceInput,
  startWorkspaceInput,
  terminalAttachmentInput,
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

  it("accepts a terminal attachment identity", () => {
    expect(
      terminalAttachmentInput.parse({
        sessionId: "session",
        terminalId: "terminal",
      }),
    ).toEqual({ sessionId: "session", terminalId: "terminal" });
  });

  it("requires a workspace revision for deletion", () => {
    expect(
      deleteWorkspaceInput.parse({
        workspaceId: "atlas",
        revision: "revision",
      }),
    ).toEqual({ workspaceId: "atlas", revision: "revision" });
    expect(() =>
      deleteWorkspaceInput.parse({ workspaceId: "atlas", revision: "" }),
    ).toThrow();
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

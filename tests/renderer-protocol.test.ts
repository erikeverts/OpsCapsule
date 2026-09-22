import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RENDERER_URL,
  resolveRendererAssetPath,
} from "../src/main/renderer-protocol.js";

const rendererRoot = resolve("dist", "renderer");

describe("renderer protocol", () => {
  it("resolves the packaged entry point inside the renderer root", () => {
    expect(resolveRendererAssetPath(RENDERER_URL, rendererRoot)).toBe(
      resolve(rendererRoot, "index.html"),
    );
  });

  it("resolves renderer assets and ignores query strings", () => {
    expect(
      resolveRendererAssetPath(
        "opscapsule://app/assets/index.js?v=1",
        rendererRoot,
      ),
    ).toBe(resolve(rendererRoot, "assets", "index.js"));
  });

  it.each([
    "https://app/index.html",
    "opscapsule://other/index.html",
    "opscapsule://user@app/index.html",
    "opscapsule://app:1234/index.html",
    "opscapsule://app/%E0%A4%A",
    "opscapsule://app/%2F..%2Fpackage.json",
  ])("rejects requests outside the renderer origin and root: %s", (url) => {
    expect(resolveRendererAssetPath(url, rendererRoot)).toBeUndefined();
  });
});

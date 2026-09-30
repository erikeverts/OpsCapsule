import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheet = () =>
  readFile(new URL("../src/renderer/src/styles.css", import.meta.url), "utf8");

function themeBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("\n}", start));
}

function tokensIn(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [
      match[1]!,
      match[2]!.trim(),
    ]),
  );
}

describe("theme tokens", () => {
  it("leaves no colour outside a theme block", async () => {
    const css = await stylesheet();
    // Everything after the theme definitions must go through a token, or a
    // theme cannot change it.
    const body = css.slice(css.indexOf('[data-theme="light"]'));
    const afterLightBlock = body.slice(body.indexOf("\n}") + 2);
    const raw = afterLightBlock.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? [];
    expect(raw).toEqual([]);
  });

  it("defines the same tokens in both themes", async () => {
    const css = await stylesheet();
    const dark = tokensIn(themeBlock(css, ':root[data-theme="dark"]'));
    const light = tokensIn(themeBlock(css, ':root[data-theme="light"]'));
    // A token missing from one theme inherits the other's value and produces
    // an unreadable patch that is easy to miss.
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
    expect(dark.size).toBeGreaterThan(100);
  });

  it("gives the two themes different values", async () => {
    const css = await stylesheet();
    const dark = tokensIn(themeBlock(css, ':root[data-theme="dark"]'));
    const light = tokensIn(themeBlock(css, ':root[data-theme="light"]'));
    const identical = [...dark].filter(([name, value]) => light.get(name) === value);
    expect(identical.length).toBeLessThan(dark.size / 4);
  });

  it("declares a colour scheme so native controls follow", async () => {
    const css = await stylesheet();
    expect(themeBlock(css, ':root[data-theme="dark"]')).toContain("color-scheme: dark");
    expect(themeBlock(css, ':root[data-theme="light"]')).toContain("color-scheme: light");
  });
});

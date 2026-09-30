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
  });

  it("keeps the palette small enough to theme by hand", async () => {
    const css = await stylesheet();
    const dark = tokensIn(themeBlock(css, ':root[data-theme="dark"]'));
    // This interface once had 197 one-off shades, most differing by less than
    // the eye can see, which made a custom theme impractical. Guarding the
    // count stops that accumulating again.
    expect(dark.size).toBeLessThan(60);
  });

  it("organises the palette into named ramps", async () => {
    const css = await stylesheet();
    const names = [...tokensIn(themeBlock(css, ':root[data-theme="dark"]')).keys()];
    // A ramp is what someone writing a theme actually edits; a flat list of
    // unrelated names is what they cannot.
    for (const family of ["surface", "accent", "success", "warning", "danger"]) {
      expect(names.some((name) => name.startsWith(`--${family}-`))).toBe(true);
    }
    // Every token belongs to a family, so nothing is unclassifiable.
    const families = new Set(names.map((name) => name.replace(/-\d+$/, "")));
    expect(families.size).toBeLessThan(12);
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

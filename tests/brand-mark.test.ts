import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const componentsDirectory = new URL(
  "../src/renderer/src/components/",
  import.meta.url,
);

describe("interface colours", () => {
  it("draws the brand mark with theme tokens", async () => {
    const source = await readFile(
      new URL("BrandMark.tsx", componentsDirectory),
      "utf8",
    );
    // As an <img> the mark carried its own colours, so the chevron and cursor
    // stayed near-white and disappeared against a light background.
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).toContain("var(--surface-12)");
    expect(source).toContain("var(--accent-");
  });

  it("keeps colours out of components, so a theme reaches everything", async () => {
    const files = (await readdir(componentsDirectory)).filter((name) =>
      name.endsWith(".tsx"),
    );
    const offenders: string[] = [];
    for (const file of files) {
      // The terminal is deliberately excepted: its palette is an xterm theme
      // whose ANSI colours assume a dark background, and is not a surface of
      // the application interface.
      if (file === "TerminalPane.tsx") {
        continue;
      }
      const source = await readFile(new URL(file, componentsDirectory), "utf8");
      if (/#[0-9a-fA-F]{6}\b/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

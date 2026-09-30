import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreferencesStore } from "../src/main/preferences.js";
import {
  defaultPreferences,
  preferencesSchema,
  resolveTheme,
} from "../src/shared/preferences.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function store() {
  const base = await mkdtemp("/tmp/oc-prefs-");
  temporary.push(base);
  return { base, store: new PreferencesStore(base) };
}

describe("theme resolution", () => {
  it("follows the system when asked to", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the system when a theme is chosen explicitly", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the system by default", () => {
    // An application that ignores the system appearance is the one that looks
    // broken at night.
    expect(defaultPreferences.theme).toBe("system");
  });
});

describe("preferences storage", () => {
  it("round-trips and writes readable JSON", async () => {
    const { base, store: preferences } = await store();
    await preferences.write({ theme: "light" });
    expect(await preferences.read()).toEqual({ theme: "light" });
    expect(
      JSON.parse(await readFile(join(base, "preferences.json"), "utf8")),
    ).toEqual({ theme: "light" });
  });

  it("returns defaults when nothing has been stored", async () => {
    const { store: preferences } = await store();
    expect(await preferences.read()).toEqual(defaultPreferences);
  });

  it("falls back to defaults rather than failing on a corrupt file", async () => {
    // A damaged preferences file must never stop someone launching a capsule;
    // the worst acceptable outcome is a theme reverting.
    const { base, store: preferences } = await store();
    await writeFile(join(base, "preferences.json"), "{ not json");
    expect(await preferences.read()).toEqual(defaultPreferences);
  });

  it("ignores a stored value that is no longer valid", async () => {
    const { base, store: preferences } = await store();
    await writeFile(
      join(base, "preferences.json"),
      JSON.stringify({ theme: "solarized" }),
    );
    expect(await preferences.read()).toEqual(defaultPreferences);
  });

  it("refuses to store an unknown setting", () => {
    expect(() => preferencesSchema.parse({ theme: "dark", rogue: true })).toThrow();
  });
});

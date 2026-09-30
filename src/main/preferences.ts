import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  defaultPreferences,
  preferencesSchema,
  type Preferences,
} from "../shared/preferences.js";

/**
 * Preferences are stored as one small file beside the application's other
 * private state.
 *
 * Unreadable or invalid content falls back to the defaults rather than
 * failing: a corrupt preferences file should never stop someone launching a
 * capsule, and the worst case is a theme reverting.
 */
export class PreferencesStore {
  constructor(private readonly baseDirectory: string) {}

  private get path(): string {
    return join(this.baseDirectory, "preferences.json");
  }

  async read(): Promise<Preferences> {
    try {
      return preferencesSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return defaultPreferences;
    }
  }

  async write(preferences: Preferences): Promise<Preferences> {
    const parsed = preferencesSchema.parse(preferences);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Written through a temporary file so an interrupted write cannot leave
    // preferences half-replaced.
    const temporary = join(dirname(this.path), `.preferences.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
    return parsed;
  }
}

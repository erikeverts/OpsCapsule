import { z } from "zod";

/**
 * Application preferences, as opposed to workspace configuration.
 *
 * These belong to the person using OpsCapsule rather than to any engagement,
 * so they live outside every workspace and are never written to a manifest.
 */
export const themePreferenceSchema = z.enum(["system", "light", "dark"]);
export type ThemePreference = z.infer<typeof themePreferenceSchema>;

/** What a theme actually resolves to once the OS has been consulted. */
export type ResolvedTheme = "light" | "dark";

export const preferencesSchema = z
  .object({
    /**
     * Following the OS is the default: an application that ignores the system
     * appearance is the one that looks broken at night.
     */
    theme: themePreferenceSchema.default("system"),
  })
  .strict();

export type Preferences = z.infer<typeof preferencesSchema>;

export const defaultPreferences: Preferences = preferencesSchema.parse({});

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}

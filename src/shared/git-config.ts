import { z } from "zod";

/**
 * A workspace may follow the user's application preference or make an
 * explicit choice. Target-level overrides are deliberately absent: Git
 * identity follows repositories and engagements, not deployment environments.
 */
export const hostGitConfigOverrideSchema = z.enum([
  "default",
  "enabled",
  "disabled",
]);
export type HostGitConfigOverride = z.infer<
  typeof hostGitConfigOverrideSchema
>;

export const workspaceGitSettingsSchema = z.object({
  inheritHostConfig: hostGitConfigOverrideSchema.default("default"),
});
export type WorkspaceGitSettings = z.infer<typeof workspaceGitSettingsSchema>;

export function resolveHostGitConfigInheritance(
  override: HostGitConfigOverride,
  applicationDefault: boolean,
): boolean {
  if (override === "enabled") {
    return true;
  }
  if (override === "disabled") {
    return false;
  }
  return applicationDefault;
}

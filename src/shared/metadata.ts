import { z } from "zod";

/**
 * Non-secret facts about a workspace or target: a project code, a cost centre,
 * the URL of a generated environment, anything a person or an agent would
 * otherwise have to go and look up.
 *
 * This is deliberately not a secret store. Values are written to the manifest
 * in plain text, returned to the renderer, and given to the agent, so anything
 * confidential belongs in a credential instead.
 */
export const METADATA_ENTRY_LIMIT = 20;

export const metadataKindSchema = z.enum(["text", "url"]);
export type MetadataKind = z.infer<typeof metadataKindSchema>;

export const metadataEntrySchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Keys use lowercase letters, digits, and single hyphens.",
      ),
    /** Shown instead of the key where there is room for it. */
    label: z.string().min(1).max(120).optional(),
    value: z.string().min(1).max(2048),
    kind: metadataKindSchema.default("text"),
    /** Shown in the sidebar for quick access. A display choice only. */
    pinned: z.boolean().default(false),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.kind !== "url") {
      return;
    }
    let url: URL;
    try {
      url = new URL(entry.value);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `'${entry.key}' is a URL entry but its value is not a URL`,
      });
      return;
    }
    // A manifest is editable and shareable, and pinned entries are opened by
    // clicking. Anything but http or https turns that into a way to run
    // something locally.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: `'${entry.key}' must be an http or https URL`,
      });
    }
  });

export type MetadataEntry = z.infer<typeof metadataEntrySchema>;

/**
 * Everything a workspace or target knows that is not configuration: facts now,
 * and reference documents later. Named for what it becomes rather than what it
 * currently holds, because the capsule receives it as one context surface and
 * adding documents should not move metadata.
 */
export const workspaceContextSchema = z
  .object({
    metadata: z.array(metadataEntrySchema).default([]),
  })
  .strict()
  .default({ metadata: [] });

export type WorkspaceContext = z.infer<typeof workspaceContextSchema>;

/**
 * Target entries override workspace entries with the same key, so a workspace
 * can state the general case and a target can correct it. That is what makes a
 * per-environment URL expressible without inventing a key per environment.
 */
export function resolveMetadata(
  workspace: readonly MetadataEntry[],
  target: readonly MetadataEntry[],
): MetadataEntry[] {
  const merged = new Map<string, MetadataEntry>();
  for (const entry of workspace) {
    merged.set(entry.key, entry);
  }
  for (const entry of target) {
    merged.set(entry.key, entry);
  }
  return [...merged.values()];
}

export function pinnedMetadata(
  entries: readonly MetadataEntry[],
): MetadataEntry[] {
  return entries.filter((entry) => entry.pinned);
}

/** Keys that suggest someone is about to put a secret in a manifest. */
const secretLikeKey =
  /(?:^|-)(?:secret|password|token|api-?key|access-?key|credential|private-?key)(?:-|$)/;

export function secretLikeMetadataKeys(
  entries: readonly MetadataEntry[],
): string[] {
  return entries.filter((entry) => secretLikeKey.test(entry.key)).map((entry) => entry.key);
}

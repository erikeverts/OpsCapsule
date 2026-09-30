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

export type MetadataKind = "text" | "url";

/**
 * Whether a value is something that can be opened.
 *
 * Derived rather than declared. A value starting with http or https is a link;
 * asking someone to say so in a second field only creates a way to get it
 * wrong, and getting it wrong makes the entry unclickable for no visible
 * reason. Anything else, including a javascript: or file: URL, is text and is
 * never clickable, which is also the safe default.
 */
export function isLinkValue(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

export function metadataKind(entry: { value: string }): MetadataKind {
  return isLinkValue(entry.value) ? "url" : "text";
}

const withoutLegacyKind = (value: unknown): unknown => {
  // `kind` was briefly a stored field. Dropped rather than tolerated, so a
  // manifest written during that window still loads.
  if (value && typeof value === "object" && !Array.isArray(value) && "kind" in value) {
    const { kind: _legacy, ...rest } = value as Record<string, unknown>;
    return rest;
  }
  return value;
};

export const metadataEntrySchema = z.preprocess(
  withoutLegacyKind,
  z
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
    /** Shown in the sidebar for quick access. A display choice only. */
    pinned: z.boolean().default(false),
  })
  .strict(),
);

export type MetadataEntry = z.infer<typeof metadataEntrySchema>;

/**
 * Reference material: runbooks, architecture notes, statements of work.
 *
 * Unlike metadata, a document is never inlined into the agent's instructions.
 * It is listed in the catalog with enough description for the agent to decide
 * whether to open it, and read from the capsule on demand. A runbook cannot go
 * in every prompt.
 */
export const DOCUMENT_LIMIT = 20;

/**
 * Documents are referenced, not inlined, so size costs disk and a copy at
 * launch rather than context on every turn. That makes a tight limit the wrong
 * trade: real runbooks are exported from wikis and carry images, and refusing
 * one for being large would push people back to pasting excerpts.
 */
export const DOCUMENT_BYTE_LIMIT = 25_000_000;

export const documentSchema = z
  .object({
    // Matches the identifier length used everywhere else in the manifest.
    // Shorter here meant identifierFromName, which truncates to 80, could
    // generate an id the schema then refused.
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Identifiers use lowercase letters, digits, and single hyphens.",
      ),
    title: z.string().min(1).max(300),
    /** What it covers, so the agent can decide whether to open it. */
    description: z.string().min(1).max(500).optional(),
    /** Workspace-relative once imported; absolute while being selected. */
    source: z.string().min(1),
  })
  .strict();

export type ContextDocument = z.infer<typeof documentSchema>;

/**
 * Everything a workspace or target knows that is not configuration: facts and
 * reference documents. The capsule receives it as one context surface, so
 * neither has to move when the other changes.
 */
export const workspaceContextSchema = z
  .object({
    metadata: z.array(metadataEntrySchema).default([]),
    documents: z.array(documentSchema).default([]),
  })
  .strict()
  .default({ metadata: [], documents: [] });

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

/** Target documents replace workspace documents with the same id. */
export function resolveDocuments(
  workspace: readonly ContextDocument[],
  target: readonly ContextDocument[],
): ContextDocument[] {
  const merged = new Map<string, ContextDocument>();
  for (const document of workspace) {
    merged.set(document.id, document);
  }
  for (const document of target) {
    merged.set(document.id, document);
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

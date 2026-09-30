import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  metadataKind,
  type ContextDocument,
  type MetadataEntry,
} from "../shared/metadata.js";

/**
 * The capsule's view of what the workspace knows.
 *
 * One surface, so that adding documents later does not move metadata or change
 * how the agent is told about any of it. The directory is written fresh on
 * every launch and is read-only as far as the agent is concerned: nothing here
 * grants filesystem or network access, it is data.
 */
export const CONTEXT_DIRECTORY_VARIABLE = "OPSCAPSULE_CONTEXT";
export const CONTEXT_FILE = "context.json";

/**
 * Metadata is small, so the catalog carries the values themselves and the
 * agent needs no tool call to know a project code. Documents will be listed
 * rather than inlined, because a runbook cannot go in every prompt.
 */
export const DOCUMENTS_DIRECTORY = "documents";

export type CapsuleDocument = ContextDocument & { readonly path: string };

export interface CapsuleContext {
  readonly metadata: readonly MetadataEntry[];
  readonly documents: readonly CapsuleDocument[];
}

/** Where a document sits inside the capsule, relative to the context root. */
export function capsuleDocumentPath(document: CapsuleDocument): string {
  return `${DOCUMENTS_DIRECTORY}/${basename(document.path)}`;
}

export function buildContextDocument(context: CapsuleContext): string {
  return `${JSON.stringify(
    {
      version: 1,
      metadata: context.metadata.map((entry) => ({
        key: entry.key,
        ...(entry.label ? { label: entry.label } : {}),
        value: entry.value,
        kind: metadataKind(entry),
      })),
      documents: context.documents.map((document) => ({
        id: document.id,
        title: document.title,
        ...(document.description ? { description: document.description } : {}),
        path: capsuleDocumentPath(document),
      })),
    },
    null,
    2,
  )}\n`;
}

/**
 * The part the agent always sees. Appended to the instructions the user wrote
 * rather than replacing them, so their words stay first.
 */
export function buildContextCatalog(context: CapsuleContext): string {
  if (context.metadata.length === 0 && context.documents.length === 0) {
    return "";
  }
  const lines: string[] = [];

  if (context.metadata.length > 0) {
    lines.push("## Workspace context", "", "Non-secret facts about this workspace and target.", "");
    for (const entry of context.metadata) {
      const name = entry.label ? `${entry.label} (\`${entry.key}\`)` : `\`${entry.key}\``;
      lines.push(`- ${name}: ${entry.value}`);
    }
    lines.push(
      "",
      `The same values are available as JSON at \`$${CONTEXT_DIRECTORY_VARIABLE}/${CONTEXT_FILE}\`.`,
      "",
    );
  }

  if (context.documents.length > 0) {
    // Listed, never inlined. The description is what lets the agent decide
    // whether a document is worth opening, so it is the only part that costs
    // context on every turn.
    lines.push(
      "## Workspace documents",
      "",
      "Reference material for this workspace. Read one when it is relevant;",
      "the contents are not included here.",
      "",
    );
    for (const document of context.documents) {
      const description = document.description ? ` — ${document.description}` : "";
      lines.push(
        `- **${document.title}**${description}: \`$${CONTEXT_DIRECTORY_VARIABLE}/${capsuleDocumentPath(document)}\``,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function composeAgentInstructions(
  written: string | undefined,
  context: CapsuleContext,
): string | undefined {
  const catalog = buildContextCatalog(context);
  if (!written && !catalog) {
    return undefined;
  }
  if (!catalog) {
    return written;
  }
  // The user's instructions lead; generated context follows, so a reader can
  // tell what was authored from what was assembled.
  return written ? `${written.trimEnd()}\n\n${catalog}` : catalog;
}

export async function writeCapsuleContext(
  directory: string,
  context: CapsuleContext,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, CONTEXT_FILE), buildContextDocument(context), {
    encoding: "utf8",
    mode: 0o600,
  });

  if (context.documents.length === 0) {
    return;
  }
  const documentsDirectory = join(directory, DOCUMENTS_DIRECTORY);
  await mkdir(documentsDirectory, { recursive: true, mode: 0o700 });
  for (const document of context.documents) {
    // Copied in, and read-only: reference material is not the agent's to
    // edit, and a capsule must not be able to rewrite what the next one is
    // told. The workspace keeps the authoritative copy.
    const destination = join(documentsDirectory, basename(document.path));
    await copyFile(document.path, destination);
    await chmod(destination, 0o400);
  }
}

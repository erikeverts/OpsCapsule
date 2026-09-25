import { readFile } from "node:fs/promises";
import type {
  CredentialReference,
  CredentialStatus,
} from "../../shared/credentials.js";
import type { WorkspaceManifest } from "../../shared/workspace-schema.js";
import { profileResolves } from "./aws-profile.js";
import { CredentialStore, scopeContext } from "./store.js";

/**
 * Resolves which storage context a reference uses. A target-scoped reference
 * needs a concrete target; when the caller did not name one, the first target
 * that selects the reference is used, so the UI can report status without the
 * user having to pick a target first.
 */
export function storageContextFor(
  manifest: WorkspaceManifest,
  reference: CredentialReference,
  targetId?: string,
): { workspaceId: string; targetId: string } {
  const resolvedTarget =
    targetId ??
    manifest.targets.find(
      (target) => target.operationalCredential === reference.id,
    )?.id ??
    "";
  return { workspaceId: manifest.metadata.id, targetId: resolvedTarget };
}

export async function credentialStatuses(
  store: CredentialStore,
  manifest: WorkspaceManifest,
): Promise<CredentialStatus[]> {
  return Promise.all(
    manifest.credentials.map(async (reference) => ({
      id: reference.id,
      name: reference.name,
      kind: reference.kind,
      scope: reference.scope,
      ...(reference.expectedAccountId
        ? { expectedAccountId: reference.expectedAccountId }
        : {}),
      ...(reference.sourceProfile
        ? { sourceProfile: reference.sourceProfile }
        : {}),
      authenticated: await isAuthenticated(store, manifest, reference),
    })),
  );
}

/**
 * An AWS profile holds no stored secret, so its status is whether the host
 * profile can currently produce credentials. Anything else is a stored secret.
 */
async function isAuthenticated(
  store: CredentialStore,
  manifest: WorkspaceManifest,
  reference: CredentialReference,
): Promise<boolean> {
  if (reference.kind === "aws-profile") {
    return reference.sourceProfile
      ? profileResolves(reference.sourceProfile)
      : false;
  }
  return store.has(
    reference,
    scopeContext(reference.scope, storageContextFor(manifest, reference)),
  );
}

export function requireReference(
  manifest: WorkspaceManifest,
  referenceId: string,
): CredentialReference {
  const reference = manifest.credentials.find(({ id }) => id === referenceId);
  if (!reference) {
    throw new Error(
      `Workspace '${manifest.metadata.id}' does not declare credential '${referenceId}'.`,
    );
  }
  return reference;
}

/**
 * Validates a secret before it is stored, so a malformed credential fails at
 * import time in the UI rather than at credential time inside a capsule.
 */
export function assertUsableSecret(
  reference: CredentialReference,
  secret: string,
): void {
  if (!secret.trim()) {
    throw new Error("The credential is empty.");
  }
  if (reference.kind === "provider-oauth") {
    try {
      JSON.parse(secret);
    } catch {
      throw new Error("A provider login must be valid JSON.");
    }
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(secret) as Record<string, unknown>;
  } catch {
    throw new Error("An AWS credential must be valid JSON.");
  }
  for (const field of ["accessKeyId", "secretAccessKey", "sessionToken"]) {
    if (!parsed[field]) {
      throw new Error(`An AWS credential needs a '${field}' field.`);
    }
  }
}

export async function readSecretFromFile(path: string): Promise<string> {
  const secret = await readFile(path, "utf8");
  if (secret.length > 200_000) {
    throw new Error("The selected file is too large to be a credential.");
  }
  return secret;
}

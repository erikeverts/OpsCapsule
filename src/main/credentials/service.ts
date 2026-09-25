import { readFile } from "node:fs/promises";
import type {
  CredentialReference,
  CredentialStatus,
} from "../../shared/credentials.js";
import type { WorkspaceManifest } from "../../shared/workspace-schema.js";
import { discoverAwsProfiles } from "../local-resources.js";
import {
  describeSsoSession,
  readSsoSessionState,
  ssoSessionSeverity,
} from "./sso-session.js";
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
  // Profile names are read once rather than per credential.
  const knownProfiles = new Set(
    (await discoverAwsProfiles().catch(() => [])).map(({ name }) => name),
  );
  return Promise.all(
    manifest.credentials.map((reference) =>
      credentialStatus(store, manifest, reference, knownProfiles),
    ),
  );
}

export async function credentialStatus(
  store: CredentialStore,
  manifest: WorkspaceManifest,
  reference: CredentialReference,
  knownProfiles?: Set<string>,
): Promise<CredentialStatus> {
  const base = {
    id: reference.id,
    name: reference.name,
    kind: reference.kind,
    scope: reference.scope,
    workspaceId: manifest.metadata.id,
    ...(reference.expectedAccountId
      ? { expectedAccountId: reference.expectedAccountId }
      : {}),
    ...(reference.sourceProfile
      ? { sourceProfile: reference.sourceProfile }
      : {}),
  };

  if (reference.kind === "aws-profile") {
    const profile = reference.sourceProfile;
    if (!profile) {
      return { ...base, authenticated: false, detail: "No profile selected" };
    }
    // Status is a file read. Resolving the profile is authoritative but costs
    // a subprocess, which is too expensive to show repeatedly in a list.
    const session = await readSsoSessionState(profile).catch(() => undefined);
    if (session) {
      const severity = ssoSessionSeverity(session);
      return {
        ...base,
        authenticated: severity !== "expired",
        ...(describeSsoSession(session)
          ? { detail: describeSsoSession(session)! }
          : {}),
        ...(severity ? { severity } : {}),
      };
    }
    const profiles =
      knownProfiles ??
      new Set((await discoverAwsProfiles().catch(() => [])).map(({ name }) => name));
    const exists = profiles.has(profile);
    return {
      ...base,
      authenticated: exists,
      detail: exists ? "Profile ready" : "Profile not found",
      ...(exists ? {} : { severity: "expired" as const }),
    };
  }

  const stored = await store.has(
    reference,
    scopeContext(reference.scope, storageContextFor(manifest, reference)),
  );
  return {
    ...base,
    authenticated: stored,
    detail: stored ? "Imported into keychain" : "Not imported",
  };
}

export interface CredentialOverview {
  /** Shared by every workspace, so they stay put as selection changes. */
  readonly user: CredentialStatus[];
  /** Belong to the selected workspace. */
  readonly workspace: CredentialStatus[];
  /** Belong to the selected target. */
  readonly target: CredentialStatus[];
}

/**
 * Groups credentials by sharing scope for the sidebar.
 *
 * User-scoped credentials are global, so they are collected across every
 * workspace and shown regardless of what is selected. Workspace and target
 * scoped ones follow the selection, because that is the boundary they belong
 * to.
 */
export async function credentialOverview(
  store: CredentialStore,
  manifests: readonly WorkspaceManifest[],
  selected: { workspaceId?: string; targetId?: string },
): Promise<CredentialOverview> {
  const knownProfiles = new Set(
    (await discoverAwsProfiles().catch(() => [])).map(({ name }) => name),
  );

  const user: CredentialStatus[] = [];
  const workspace: CredentialStatus[] = [];
  const target: CredentialStatus[] = [];
  const seenUserIds = new Set<string>();

  for (const manifest of manifests) {
    const isSelectedWorkspace = manifest.metadata.id === selected.workspaceId;
    for (const reference of manifest.credentials) {
      if (reference.scope === "user") {
        // The same user credential may be declared by several workspaces; it
        // resolves to one stored secret, so it is listed once.
        if (seenUserIds.has(reference.id)) {
          continue;
        }
        seenUserIds.add(reference.id);
        user.push(
          await credentialStatus(store, manifest, reference, knownProfiles),
        );
        continue;
      }
      if (!isSelectedWorkspace) {
        continue;
      }
      if (reference.scope === "workspace") {
        workspace.push(
          await credentialStatus(store, manifest, reference, knownProfiles),
        );
        continue;
      }
      // Target-scoped: only the selected target's own credentials.
      const usedByTarget = manifest.targets.some(
        (candidate) =>
          candidate.id === selected.targetId &&
          candidate.operationalCredential === reference.id,
      );
      if (usedByTarget) {
        target.push(
          await credentialStatus(store, manifest, reference, knownProfiles),
        );
      }
    }
  }

  return { user, workspace, target };
}

export function requireReference(
  manifest: WorkspaceManifest,
  referenceId: string,
): CredentialReference {
  const reference = manifest.credentials.find(({ id }) => id === referenceId);
  if (!reference) {
    // Most often this means the credential exists only in an unsaved draft.
    // Authentication deliberately acts on the saved manifest, so that the
    // renderer cannot make the main process act on a reference it invented.
    throw new Error(
      `Credential '${referenceId}' is not saved in workspace '${manifest.metadata.id}'. Save the workspace and try again.`,
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

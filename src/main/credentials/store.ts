import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialReference, CredentialScope } from "../../shared/credentials.js";

/**
 * Encryption is injected so the store can be tested without an Electron
 * runtime. In the application this is backed by Electron `safeStorage`, whose
 * key lives in the OS keychain rather than in any file OpsCapsule controls.
 */
export interface SecretEncryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class CredentialStorageUnavailableError extends Error {
  constructor() {
    super(
      "OS-backed encryption is unavailable, so credentials cannot be stored. " +
        "OpsCapsule refuses to fall back to plaintext.",
    );
    this.name = "CredentialStorageUnavailableError";
  }
}

export class CredentialNotStoredError extends Error {
  constructor(referenceId: string) {
    super(`No stored secret for credential reference: ${referenceId}`);
    this.name = "CredentialNotStoredError";
  }
}

/**
 * Secrets are addressed by scope and reference id, never by target. A
 * user-scoped reference resolves to one file no matter which workspace or
 * target is running, which is what makes a single global inference identity
 * reusable. A target-scoped reference is partitioned by workspace and target
 * so environments cannot share one.
 */
export function credentialSecretPath(
  baseDirectory: string,
  reference: CredentialReference,
  context: { workspaceId?: string; targetId?: string },
): string {
  const root = join(baseDirectory, "credentials");
  const safeId = `${reference.id}.bin`;
  switch (reference.scope) {
    case "user":
      return join(root, "user", safeId);
    case "workspace": {
      if (!context.workspaceId) {
        throw new Error(
          `Credential reference ${reference.id} is workspace-scoped but no workspace was supplied.`,
        );
      }
      return join(root, "workspaces", context.workspaceId, safeId);
    }
    case "target": {
      if (!context.workspaceId || !context.targetId) {
        throw new Error(
          `Credential reference ${reference.id} is target-scoped but no target was supplied.`,
        );
      }
      return join(
        root,
        "workspaces",
        context.workspaceId,
        "targets",
        context.targetId,
        safeId,
      );
    }
    default: {
      const exhaustive: never = reference.scope;
      throw new Error(`Unsupported credential scope: ${String(exhaustive)}`);
    }
  }
}

export interface CredentialStoreContext {
  readonly workspaceId?: string;
  readonly targetId?: string;
}

export class CredentialStore {
  constructor(
    private readonly baseDirectory: string,
    private readonly encryptor: SecretEncryptor,
  ) {}

  private pathFor(
    reference: CredentialReference,
    context: CredentialStoreContext,
  ): string {
    return credentialSecretPath(this.baseDirectory, reference, context);
  }

  private assertAvailable(): void {
    if (!this.encryptor.isEncryptionAvailable()) {
      throw new CredentialStorageUnavailableError();
    }
  }

  async write(
    reference: CredentialReference,
    secret: string,
    context: CredentialStoreContext = {},
  ): Promise<void> {
    this.assertAvailable();
    const path = this.pathFor(reference, context);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, this.encryptor.encryptString(secret), { mode: 0o600 });
    await chmod(path, 0o600);
  }

  async read(
    reference: CredentialReference,
    context: CredentialStoreContext = {},
  ): Promise<string> {
    this.assertAvailable();
    const path = this.pathFor(reference, context);
    let encrypted: Buffer;
    try {
      encrypted = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CredentialNotStoredError(reference.id);
      }
      throw error;
    }
    try {
      return this.encryptor.decryptString(encrypted);
    } catch {
      // A secret that cannot be decrypted is treated as absent rather than as
      // a hard crash: the keychain entry may belong to another machine or user.
      throw new CredentialNotStoredError(reference.id);
    }
  }

  async has(
    reference: CredentialReference,
    context: CredentialStoreContext = {},
  ): Promise<boolean> {
    try {
      await access(this.pathFor(reference, context), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Logout. Removes the stored secret without touching the reference itself. */
  async forget(
    reference: CredentialReference,
    context: CredentialStoreContext = {},
  ): Promise<void> {
    await rm(this.pathFor(reference, context), { force: true });
  }
}

export function scopeContext(
  scope: CredentialScope,
  context: Required<CredentialStoreContext>,
): CredentialStoreContext {
  switch (scope) {
    case "user":
      return {};
    case "workspace":
      return { workspaceId: context.workspaceId };
    case "target":
      return context;
  }
}

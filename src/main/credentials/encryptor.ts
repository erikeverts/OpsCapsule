import { safeStorage } from "electron";
import type { SecretEncryptor } from "./store.js";

/**
 * Electron's `safeStorage`, with the Linux backend checked.
 *
 * On Linux, when no keyring is reachable, Chromium falls back to a backend it
 * calls `basic_text`, which encrypts with a hardcoded key. That is obfuscation,
 * not encryption: anyone who can read the file can read the secret.
 *
 * `isAsyncEncryptionAvailable()` returns true in that state, so taking it at
 * face value would have OpsCapsule store credentials it believes are protected.
 * The store is built to fail closed rather than degrade to plaintext, and this
 * is what makes that true on Linux as well as macOS.
 */
export type LinuxStorageBackend = ReturnType<
  typeof safeStorage.getSelectedStorageBackend
>;

/** Backends that do not actually protect anything. */
const unprotectedBackends: ReadonlySet<string> = new Set([
  "basic_text",
  "unknown",
]);

export function isProtectedBackend(backend: string): boolean {
  return !unprotectedBackends.has(backend);
}

export function createSecretEncryptor(
  storage: Pick<
    typeof safeStorage,
    | "isAsyncEncryptionAvailable"
    | "encryptStringAsync"
    | "decryptStringAsync"
  > & { getSelectedStorageBackend?: () => string },
  platform: NodeJS.Platform = process.platform,
): SecretEncryptor {
  return {
    async isEncryptionAvailable() {
      if (!(await storage.isAsyncEncryptionAvailable())) {
        return false;
      }
      if (platform !== "linux") {
        return true;
      }
      // Only Linux exposes a backend, and only Linux has a weak one.
      const backend = storage.getSelectedStorageBackend?.();
      return backend === undefined ? true : isProtectedBackend(backend);
    },
    encryptString: (value) => storage.encryptStringAsync(value),
    decryptString: (value) => storage.decryptStringAsync(value),
    unavailableReason: () => describeUnavailableStorage(platform),
  };
}

export function describeUnavailableStorage(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "linux") {
    return (
      "No system keyring is available, so credentials cannot be stored safely. " +
      "Install and unlock gnome-keyring or kwallet, then try again."
    );
  }
  return "OS-backed encryption is unavailable, so credentials cannot be stored.";
}

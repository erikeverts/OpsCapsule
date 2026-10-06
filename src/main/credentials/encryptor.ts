import { safeStorage } from "electron";
import type { SecretEncryptor } from "./store.js";

/**
 * Electron's `safeStorage`, with the Linux backend checked.
 *
 * On Linux, when no keyring is reachable, Chromium falls back to a backend it
 * calls `basic_text`, which encrypts with a hardcoded key. That is obfuscation,
 * not encryption: anyone who can read the file can read the secret.
 *
 * `isEncryptionAvailable()` returns true in that state, so taking it at face
 * value would have OpsCapsule store credentials it believes are protected. The
 * store is built to fail closed rather than degrade to plaintext, and this is
 * what makes that true on Linux as well as macOS.
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
    "isEncryptionAvailable" | "encryptString" | "decryptString"
  > & { getSelectedStorageBackend?: () => string },
  platform: NodeJS.Platform = process.platform,
): SecretEncryptor {
  return {
    isEncryptionAvailable() {
      if (!storage.isEncryptionAvailable()) {
        return false;
      }
      if (platform !== "linux") {
        return true;
      }
      // Only Linux exposes a backend, and only Linux has a weak one.
      const backend = storage.getSelectedStorageBackend?.();
      return backend === undefined ? true : isProtectedBackend(backend);
    },
    encryptString: (value) => storage.encryptString(value),
    decryptString: (value) => storage.decryptString(value),
    unavailableReason: () => describeUnavailableStorage(platform),
  };
}

export function describeUnavailableStorage(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "linux") {
    return "OS-backed encryption is unavailable, so credentials cannot be stored.";
  }
  // A keyring is reached over the session bus, so a missing bus and a missing
  // keyring look identical from here. They need different fixes, and telling
  // someone to install a keyring they already have is a poor way to spend
  // their afternoon.
  if (!environment.DBUS_SESSION_BUS_ADDRESS) {
    return (
      "No D-Bus session is available, so the keyring cannot be reached. " +
      "Start OpsCapsule inside a session that also runs the keyring, for " +
      "example with dbus-run-session."
    );
  }
  return (
    "No system keyring is available, so credentials cannot be stored safely. " +
    "Install and unlock gnome-keyring or kwallet, then try again."
  );
}

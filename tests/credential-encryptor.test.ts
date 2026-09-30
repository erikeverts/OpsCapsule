import { describe, expect, it } from "vitest";
import {
  createSecretEncryptor,
  describeUnavailableStorage,
  isProtectedBackend,
} from "../src/main/credentials/encryptor.js";
import { CredentialStorageUnavailableError, CredentialStore } from "../src/main/credentials/store.js";

const storage = (
  available: boolean,
  backend?: string,
) => ({
  isEncryptionAvailable: () => available,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
  ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
});

describe("Linux keyring backends", () => {
  it("rejects the backends that do not protect anything", () => {
    // basic_text encrypts with a hardcoded key, so anyone who can read the
    // file can read the secret.
    expect(isProtectedBackend("basic_text")).toBe(false);
    expect(isProtectedBackend("unknown")).toBe(false);
  });

  it("accepts a real keyring", () => {
    for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
      expect(isProtectedBackend(backend)).toBe(true);
    }
  });
});

describe("encryptor", () => {
  it("refuses to store on Linux when the keyring is missing", () => {
    // safeStorage reports encryption as available in this state, so taking it
    // at face value would store credentials that are not protected.
    const encryptor = createSecretEncryptor(storage(true, "basic_text"), "linux");
    expect(encryptor.isEncryptionAvailable()).toBe(false);
    expect(encryptor.unavailableReason?.()).toMatch(/keyring/);
  });

  it("allows storage on Linux with a real keyring", () => {
    expect(
      createSecretEncryptor(storage(true, "gnome_libsecret"), "linux")
        .isEncryptionAvailable(),
    ).toBe(true);
  });

  it("does not consult a backend on platforms that have none", () => {
    // Only Linux exposes a backend, and only Linux has a weak one.
    expect(
      createSecretEncryptor(storage(true), "darwin").isEncryptionAvailable(),
    ).toBe(true);
    expect(
      createSecretEncryptor(storage(true, "basic_text"), "darwin")
        .isEncryptionAvailable(),
    ).toBe(true);
  });

  it("still refuses when the platform reports no encryption at all", () => {
    expect(
      createSecretEncryptor(storage(false), "darwin").isEncryptionAvailable(),
    ).toBe(false);
  });

  it("names the remedy on Linux and stays generic elsewhere", () => {
    expect(describeUnavailableStorage("linux")).toMatch(/gnome-keyring|kwallet/);
    expect(describeUnavailableStorage("darwin")).not.toMatch(/keyring/);
  });
});

describe("the store refuses to write without real protection", () => {
  it("reports why, rather than only that", async () => {
    const store = new CredentialStore(
      "/unused",
      createSecretEncryptor(storage(true, "basic_text"), "linux"),
    );
    await expect(
      store.write(
        { id: "x", name: "X", kind: "provider-oauth", scope: "user" },
        "secret",
      ),
    ).rejects.toThrow(CredentialStorageUnavailableError);
    await expect(
      store.write(
        { id: "x", name: "X", kind: "provider-oauth", scope: "user" },
        "secret",
      ),
    ).rejects.toThrow(/keyring.*refuses to fall back to plaintext/s);
  });
});

import { describe, expect, it } from "vitest";
import { checkCredentialReadiness } from "../src/main/credentials/readiness.js";
import type { CredentialReference } from "../src/shared/credentials.js";

const copilot: CredentialReference = {
  id: "copilot",
  name: "Copilot",
  kind: "provider-oauth",
  scope: "user",
  providerId: "opencode",
  sourceProfile: "github-copilot",
};

const awsRole: CredentialReference = {
  id: "role",
  name: "Assumed role",
  kind: "aws-role",
  scope: "target",
};

/** The real adapters, with the transport probe forced so tests are portable. */
const withTransport = { transportAvailable: async () => true };
const withoutTransport = { transportAvailable: async () => false };

describe("credential readiness", () => {
  it("says nothing when a target brokers no credentials", async () => {
    expect(
      await checkCredentialReadiness({ hasStoredSecret: async () => false }),
    ).toBeUndefined();
  });

  it("blocks launch when a provider login has never been imported", async () => {
    const check = await checkCredentialReadiness(
      { inference: copilot, hasStoredSecret: async () => false },
      withTransport,
    );
    // Without this the agent starts, silently falls back to another provider,
    // and the cause only appears in the agent's own error reporting.
    expect(check!.status).toBe("fail");
    expect(check!.detail).toMatch(/has not been imported/);
  });

  it("passes an imported provider login", async () => {
    const check = await checkCredentialReadiness(
      { inference: copilot, hasStoredSecret: async () => true },
      withTransport,
    );
    expect(check!.status).toBe("pass");
  });

  it("blocks an AWS identity that names no profile", async () => {
    const check = await checkCredentialReadiness(
      {
        operational: { id: "ops", name: "Ops", kind: "aws-profile", scope: "target" },
        hasStoredSecret: async () => false,
      },
      withTransport,
    );
    expect(check!.status).toBe("fail");
    expect(check!.detail).toMatch(/names no AWS profile/);
  });

  it("blocks a role reference, which cannot be delivered yet", async () => {
    const check = await checkCredentialReadiness(
      { operational: awsRole, hasStoredSecret: async () => false },
      withTransport,
    );
    expect(check!.status).toBe("fail");
    expect(check!.detail).toMatch(/not implemented/);
  });

  it("blocks launch when the broker transport is missing", async () => {
    // Pull delivery needs curl in the capsule; without it every credential
    // request becomes an opaque agent error.
    const check = await checkCredentialReadiness(
      {
        operational: {
          id: "ops",
          name: "Ops",
          kind: "aws-profile",
          scope: "target",
          sourceProfile: "opscapsule-does-not-exist",
        },
        hasStoredSecret: async () => false,
      },
      withoutTransport,
    );
    expect(check!.status).toBe("fail");
    expect(check!.detail).toMatch(/curl is required/);
  }, 30_000);

  it("does not require the transport for a materialized login", async () => {
    // A Copilot-only target opens no broker channel, so a missing curl is
    // irrelevant to it.
    const check = await checkCredentialReadiness(
      { inference: copilot, hasStoredSecret: async () => true },
      withoutTransport,
    );
    expect(check!.status).toBe("pass");
  });

  it("reports an AWS profile that cannot provide credentials", async () => {
    const check = await checkCredentialReadiness(
      {
        operational: {
          id: "ops",
          name: "Ops",
          kind: "aws-profile",
          scope: "target",
          sourceProfile: "opscapsule-does-not-exist",
        },
        hasStoredSecret: async () => false,
      },
      withTransport,
    );
    expect(check!.status).toBe("fail");
    expect(check!.detail).toMatch(/Ops/);
  }, 30_000);
});

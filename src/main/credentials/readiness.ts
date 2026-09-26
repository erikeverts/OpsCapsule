import type { TargetReadinessCheck } from "../../shared/contracts.js";
import type { CredentialReference } from "../../shared/credentials.js";
import {
  AwsProfileError,
  brokerTransportAvailable,
  callerIdentity,
  exportProfileCredentials,
} from "./aws-profile.js";
import { CredentialDeliveryRegistry } from "./delivery/registry.js";

/**
 * Verifies that a target can actually obtain the credentials it is configured
 * to use, before a capsule is launched.
 *
 * Without this, a credential problem first appears inside the capsule, where
 * the agent reports it in its own words: an expired sign-in surfaces as the
 * model provider failing, which is a long way from the cause. Checking here
 * turns those into a message next to the launch button.
 *
 * It also delivers the account verification ADR 0007 decided on. Until now
 * `expectedAccountId` was displayed and never checked, so a target could show
 * one account and use another.
 */
export interface CredentialReadinessInput {
  readonly operational?: CredentialReference;
  readonly inference?: CredentialReference;
  readonly hasStoredSecret: (
    reference: CredentialReference,
  ) => Promise<boolean>;
}

async function checkAwsReference(
  reference: CredentialReference,
  role: string,
): Promise<{ status: TargetReadinessCheck["status"]; detail: string }> {
  if (!reference.sourceProfile) {
    return {
      status: "fail",
      detail: `The ${role} identity '${reference.name}' names no AWS profile.`,
    };
  }

  try {
    await exportProfileCredentials(reference.sourceProfile);
  } catch (error) {
    // An expired sign-in is the common case and is the user's to fix, so it
    // blocks rather than warns.
    // Name the credential as well as the profile: in a list of several, the
    // profile name alone does not say which one to go and fix.
    return {
      status: "fail",
      detail: `The ${role} identity '${reference.name}' cannot provide credentials. ${
        error instanceof AwsProfileError ? error.message : ""
      }`.trim(),
    };
  }

  if (!reference.expectedAccountId) {
    return {
      status: "pass",
      detail: `The ${role} identity '${reference.name}' resolves.`,
    };
  }

  try {
    const identity = await callerIdentity(reference.sourceProfile);
    if (identity.accountId !== reference.expectedAccountId) {
      return {
        status: "fail",
        detail: `The ${role} identity '${reference.name}' resolves to account ${identity.accountId}, not the expected ${reference.expectedAccountId}.`,
      };
    }
    return {
      status: "pass",
      detail: `The ${role} identity '${reference.name}' is account ${identity.accountId}.`,
    };
  } catch (error) {
    // Being offline is not a configuration problem, so it must not stop work.
    return {
      status: "warning",
      detail: `The account behind '${reference.name}' could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export interface CredentialReadinessOptions {
  readonly delivery?: CredentialDeliveryRegistry;
  /** Injected so the missing-transport case is testable on a host that has it. */
  readonly transportAvailable?: () => Promise<boolean>;
}

export async function checkCredentialReadiness(
  input: CredentialReadinessInput,
  options: CredentialReadinessOptions = {},
): Promise<TargetReadinessCheck | undefined> {
  const delivery = options.delivery ?? new CredentialDeliveryRegistry();
  const transportAvailable =
    options.transportAvailable ?? brokerTransportAvailable;
  const assignments = [
    input.operational ? { role: "operational", reference: input.operational } : undefined,
    input.inference ? { role: "inference", reference: input.inference } : undefined,
  ].filter((entry) => entry !== undefined);

  if (assignments.length === 0) {
    return undefined;
  }

  const details: string[] = [];
  let status: TargetReadinessCheck["status"] = "pass";
  const worsen = (next: TargetReadinessCheck["status"]) => {
    if (next === "fail" || (next === "warning" && status === "pass")) {
      status = next;
    }
  };

  // A capsule only needs the transport when something pulls at point of use.
  if (
    delivery.requiresBrokerChannel(
      assignments.map(({ reference }) => reference),
    ) &&
    !(await transportAvailable())
  ) {
    worsen("fail");
    details.push(
      "curl is required to deliver credentials into the capsule and was not found.",
    );
  }

  for (const { role, reference } of assignments) {
    if (reference.kind === "provider-oauth") {
      const stored = await input.hasStoredSecret(reference);
      worsen(stored ? "pass" : "fail");
      details.push(
        stored
          ? `The ${role} login '${reference.name}' is imported.`
          : `The ${role} login '${reference.name}' has not been imported.`,
      );
      continue;
    }
    if (reference.kind === "aws-role") {
      worsen("fail");
      details.push(
        `'${reference.name}' needs STS role assumption, which is not implemented.`,
      );
      continue;
    }
    const result = await checkAwsReference(reference, role);
    worsen(result.status);
    details.push(result.detail);
  }

  return {
    id: "credentials",
    label: "Credentials",
    status,
    detail: details.join(" "),
  };
}

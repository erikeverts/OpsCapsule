import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialReference } from "../../../shared/credentials.js";
import type {
  CredentialDeliveryAdapter,
  DeliveryContext,
} from "./types.js";

export const OPERATIONAL_PROFILE_NAME = "default";
export const INFERENCE_PROFILE_NAME = "opscapsule-inference";

/**
 * AWS delivers through `credential_process`, so nothing is stored inside the
 * capsule. The operational identity is the default profile; the inference
 * identity is named but is never the default and is never referenced from the
 * environment, because any AWS_* variable reaching the agent also reaches the
 * operational commands it spawns.
 */
export class AwsCredentialDelivery implements CredentialDeliveryAdapter {
  readonly id = "aws";
  readonly transport = "pull" as const;

  async prepare(context: DeliveryContext): Promise<void> {
    if (!context.helperPath) {
      throw new Error(
        "AWS credential delivery requires a broker helper inside the capsule.",
      );
    }
    const operational = context.assignments.find(
      ({ role }) => role === "operational",
    )?.reference;
    const inference = context.assignments.find(
      ({ role }) => role === "inference",
    )?.reference;

    await writeFile(
      join(context.targetState, ".aws", "config"),
      buildCapsuleAwsConfig({
        helperPath: context.helperPath,
        operational,
        inference,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
  }

  /**
   * `Version: 1` with top-level keys is the AWS `credential_process` contract,
   * and Claude Code documents that `awsCredentialExport` accepts the same flat
   * shape, so one response serves both.
   */
  formatResponse(secret: string): string {
    const parsed = JSON.parse(secret) as Record<string, string>;
    if (!parsed.accessKeyId || !parsed.secretAccessKey || !parsed.sessionToken) {
      throw new Error("Stored AWS credential is missing required fields.");
    }
    return `${JSON.stringify({
      Version: 1,
      AccessKeyId: parsed.accessKeyId,
      SecretAccessKey: parsed.secretAccessKey,
      SessionToken: parsed.sessionToken,
      ...(parsed.expiration ? { Expiration: parsed.expiration } : {}),
    })}\n`;
  }
}

export interface CapsuleAwsIdentities {
  readonly helperPath: string;
  readonly operational?: CredentialReference;
  readonly inference?: CredentialReference;
}

export function buildCapsuleAwsConfig(
  identities: CapsuleAwsIdentities,
): string {
  const sections: string[] = [];

  if (identities.operational) {
    sections.push(
      `[${OPERATIONAL_PROFILE_NAME}]`,
      ...regionLine(identities.operational.region),
      `credential_process = ${identities.helperPath} ${identities.operational.id}`,
    );
  }

  if (identities.inference) {
    if (identities.inference.id === identities.operational?.id) {
      throw new Error(
        "The inference identity must not reuse the operational credential reference.",
      );
    }
    if (sections.length > 0) {
      sections.push("");
    }
    sections.push(
      `[profile ${INFERENCE_PROFILE_NAME}]`,
      ...regionLine(identities.inference.region),
      `credential_process = ${identities.helperPath} ${identities.inference.id}`,
    );
  }

  return sections.length > 0 ? `${sections.join("\n")}\n` : "";
}

function regionLine(region: string | undefined): string[] {
  return region ? [`region = ${region}`] : [];
}

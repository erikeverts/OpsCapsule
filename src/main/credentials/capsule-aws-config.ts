// SPIKE (ADR 0007). Not wired into the launch path yet.
//
// Builds the capsule's AWS config containing two named identities. The
// operational identity stays the default profile and stays the value of
// AWS_PROFILE, so shells and every operational command the agent spawns are
// unchanged. The inference identity is present but is never the default and is
// never referenced from the process environment, because any AWS_* variable
// that reaches the agent also reaches the `aws` and `kubectl` children it
// spawns.
//
// Selection of the inference identity therefore happens in the agent's own
// provider configuration:
//   - OpenCode: provider."amazon-bedrock".options.profile, which the OpenCode
//     docs state takes precedence over environment variables;
//   - Claude Code: awsCredentialExport, which Anthropic documents for exactly
//     this case ("when your Amazon Bedrock account requires cross-account
//     credentials that differ from the ones the default provider chain would
//     resolve").

export const OPERATIONAL_PROFILE_NAME = "default";
export const INFERENCE_PROFILE_NAME = "opscapsule-inference";

export interface BrokeredIdentity {
  readonly referenceId: string;
  readonly region: string;
}

export interface CapsuleAwsConfigInput {
  readonly helperCommand: string;
  readonly operational: BrokeredIdentity;
  readonly inference?: BrokeredIdentity;
}

function credentialProcessCommand(
  helperCommand: string,
  referenceId: string,
): string {
  if (/\s/.test(referenceId)) {
    throw new Error(
      `Credential reference ids cannot contain whitespace: ${referenceId}`,
    );
  }
  return `${helperCommand} --reference ${referenceId}`;
}

export function buildCapsuleAwsConfig(input: CapsuleAwsConfigInput): string {
  const sections = [
    `[${OPERATIONAL_PROFILE_NAME}]`,
    `region = ${input.operational.region}`,
    `credential_process = ${credentialProcessCommand(
      input.helperCommand,
      input.operational.referenceId,
    )}`,
  ];

  if (input.inference) {
    if (input.inference.referenceId === input.operational.referenceId) {
      throw new Error(
        "The inference identity must not reuse the operational credential reference.",
      );
    }
    sections.push(
      "",
      `[profile ${INFERENCE_PROFILE_NAME}]`,
      `region = ${input.inference.region}`,
      `credential_process = ${credentialProcessCommand(
        input.helperCommand,
        input.inference.referenceId,
      )}`,
    );
  }

  return `${sections.join("\n")}\n`;
}

/**
 * The environment always names the operational identity, whether or not an
 * inference identity exists. This function exists so the invariant is
 * testable rather than merely described.
 */
export function buildCapsuleAwsEnvironment(
  input: CapsuleAwsConfigInput,
): Record<string, string> {
  return {
    AWS_PROFILE: OPERATIONAL_PROFILE_NAME,
    AWS_REGION: input.operational.region,
    AWS_DEFAULT_REGION: input.operational.region,
  };
}

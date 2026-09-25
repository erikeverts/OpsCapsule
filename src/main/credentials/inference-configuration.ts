import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CredentialReference } from "../../shared/credentials.js";
import { INFERENCE_PROFILE_NAME } from "./delivery/aws.js";

/**
 * Materializes the agent-side configuration that selects the inference
 * identity.
 *
 * Without this the user would have to hand-edit configuration inside the
 * capsule, and an agent that was not edited would silently fall back to
 * AWS_PROFILE - billing model inference to the customer's operational account,
 * which is the failure issue #6 was opened about. Configuring a workspace must
 * be enough.
 *
 * Existing managed configuration is merged rather than replaced, because a
 * profile may legitimately import its own settings file.
 */
export interface InferenceConfigurationContext {
  readonly home: string;
  readonly agentState: string;
  readonly adapter: string;
  readonly reference: CredentialReference;
  /** Capsule path of the broker helper, for adapters that call it directly. */
  readonly helperPath?: string;
}

async function mergeJsonFile(
  path: string,
  mutate: (document: Record<string, unknown>) => void,
): Promise<void> {
  let document: Record<string, unknown> = {};
  const existing = await readFile(path, "utf8").catch(() => "");
  if (existing.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        document = parsed as Record<string, unknown>;
      }
    } catch {
      // A malformed managed file is left alone rather than silently rewritten;
      // the inference selection is added to a fresh document instead.
      document = {};
    }
  }
  mutate(document);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function section(
  document: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = document[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  document[key] = created;
  return created;
}

export async function applyInferenceConfiguration(
  context: InferenceConfigurationContext,
): Promise<void> {
  if (!context.reference.kind.startsWith("aws")) {
    // A provider login is delivered as a credential file, not selected here.
    return;
  }

  if (context.adapter === "opencode") {
    // OpenCode selects a Bedrock profile by name, and documents that config
    // file options take precedence over environment variables.
    await mergeJsonFile(
      join(context.home, ".config", "opencode", "opencode.json"),
      (document) => {
        const provider = section(document, "provider");
        const bedrock = section(provider, "amazon-bedrock");
        const options = section(bedrock, "options");
        options.profile = INFERENCE_PROFILE_NAME;
        if (context.reference.region) {
          options.region = context.reference.region;
        }
      },
    );
    return;
  }

  if (context.adapter === "claude-code") {
    // Claude Code has no profile option; awsCredentialExport is documented for
    // exactly this case, so it is pointed straight at the broker helper.
    if (!context.helperPath) {
      return;
    }
    await mergeJsonFile(
      join(context.agentState, "data", "claude", "settings.json"),
      (document) => {
        document.awsCredentialExport = `${context.helperPath} ${context.reference.id}`;
        const environment = section(document, "env");
        environment.CLAUDE_CODE_USE_BEDROCK = "1";
        if (context.reference.region) {
          environment.AWS_REGION = context.reference.region;
        }
      },
    );
  }
}

/**
 * Non-secret hints a generic command adapter can use to reach the inference
 * identity.
 *
 * Deliberately limited to the profile name and region. The environment is
 * shared by the agent and both shell panes, so it must not carry a command
 * that mints inference credentials: that would hand every shell in the capsule
 * the ability to spend the inference account. Agents that need to invoke the
 * broker directly receive the command in their own configuration file instead.
 */
export function inferenceEnvironment(
  reference: CredentialReference | undefined,
): Record<string, string> {
  if (!reference?.kind.startsWith("aws")) {
    return {};
  }
  return {
    OPSCAPSULE_INFERENCE_PROFILE: INFERENCE_PROFILE_NAME,
    ...(reference.region
      ? { OPSCAPSULE_INFERENCE_REGION: reference.region }
      : {}),
  };
}

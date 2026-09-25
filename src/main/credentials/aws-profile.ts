import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * AWS profiles are not secrets and are not stored by OpsCapsule.
 *
 * A reference of kind `aws-profile` names a profile on the host. Credentials
 * are minted from it in the main process at the moment a capsule asks, using
 * the AWS CLI's own resolution. That keeps the SSO cache, role chain, and any
 * long-lived keys entirely outside the capsule: the capsule receives only the
 * resulting short-lived session.
 *
 * `aws configure export-credentials --format process` emits exactly the
 * `credential_process` contract, so the output is passed through untouched.
 */
export class AwsProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsProfileError";
  }
}

function describeFailure(profile: string, stderr: string): string {
  const detail = stderr.trim().split("\n").pop() ?? "";
  if (/sso|token.*expired|expired.*token/i.test(detail)) {
    return `The SSO session for '${profile}' has expired. Sign in again.`;
  }
  if (/could not be found|does not exist/i.test(detail)) {
    return `AWS profile '${profile}' was not found on this host.`;
  }
  return detail
    ? `AWS profile '${profile}' could not provide credentials: ${detail}`
    : `AWS profile '${profile}' could not provide credentials.`;
}

export async function exportProfileCredentials(
  profile: string,
): Promise<string> {
  try {
    const { stdout } = await run(
      "aws",
      [
        "configure",
        "export-credentials",
        "--profile",
        profile,
        "--format",
        "process",
      ],
      { timeout: 30_000 },
    );
    const payload = JSON.parse(stdout) as { AccessKeyId?: string };
    if (!payload.AccessKeyId) {
      throw new AwsProfileError(
        `AWS profile '${profile}' returned no credentials.`,
      );
    }
    // Emitted verbatim: this is already the credential_process contract, and
    // Claude Code accepts the same flat shape for awsCredentialExport.
    return `${JSON.stringify(payload)}\n`;
  } catch (error) {
    if (error instanceof AwsProfileError) {
      throw error;
    }
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") {
      throw new AwsProfileError(
        "The AWS CLI is not installed, so profile credentials cannot be resolved.",
      );
    }
    throw new AwsProfileError(describeFailure(profile, failure.stderr ?? ""));
  }
}

/** Non-mutating check used for authentication status. Never opens a browser. */
export async function profileResolves(profile: string): Promise<boolean> {
  try {
    await exportProfileCredentials(profile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Interactive sign-in. Runs in the main process, outside any capsule, so the
 * refreshed SSO token never enters the sandbox.
 */
export async function ssoLogin(profile: string): Promise<void> {
  try {
    await run("aws", ["sso", "login", "--profile", profile], {
      timeout: 180_000,
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") {
      throw new AwsProfileError("The AWS CLI is not installed.");
    }
    throw new AwsProfileError(
      `Sign-in failed for '${profile}': ${(failure.stderr ?? "").trim() || "unknown error"}`,
    );
  }
}

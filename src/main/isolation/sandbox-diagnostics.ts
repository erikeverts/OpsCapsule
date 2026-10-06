/**
 * A failed sandbox probe says little on its own. These helpers turn what the
 * sandbox reported into something a person can act on.
 */

/**
 * Unprivileged user namespaces are the usual reason the sandbox cannot start
 * on Linux, and nothing in the raw error names them. Ubuntu 24.04 and WSL
 * restrict them by default.
 */
export function describeSandboxFailure(
  detail: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const namespaces =
    /user namespace|CLONE_NEWUSER|setting up uid map|unshare|Operation not permitted/i.test(
      detail,
    );
  if (platform === "linux" && namespaces) {
    return (
      `${detail} This host restricts unprivileged user namespaces, which the ` +
      "sandbox needs. See docs/windows-wsl.md."
    );
  }
  return detail;
}

/**
 * Prefers what the failing process printed over the wrapper's own message,
 * since the wrapper only ever reports a non-zero exit code.
 */
export function explainProbeFailure(error: unknown): string {
  const stderr = (error as { stderr?: string })?.stderr?.trim();
  if (stderr && stderr.length > 0) {
    return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

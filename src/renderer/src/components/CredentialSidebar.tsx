import type { CredentialStatus } from "../../../shared/credentials";

interface CredentialSidebarProps {
  user: CredentialStatus[];
  workspace: CredentialStatus[];
  target: CredentialStatus[];
  busyId: string | null;
  disabled: boolean;
  onAction: (credential: CredentialStatus) => void;
}

/**
 * Credentials are grouped by sharing scope rather than listed flat, because
 * scope is what decides whether an entry follows the current selection. A
 * user-scoped identity is global and stays put; a target-scoped one belongs to
 * the target and swaps with it.
 */
export function CredentialSidebar({
  user,
  workspace,
  target,
  busyId,
  disabled,
  onAction,
}: CredentialSidebarProps) {
  const groups = [
    { label: "Your identities", entries: user, hint: "Shared by every workspace" },
    { label: "Workspace identities", entries: workspace, hint: undefined },
    { label: "Target identities", entries: target, hint: undefined },
  ].filter((group) => group.entries.length > 0);

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="credential-sidebar">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="section-label">{group.label}</p>
          {group.hint ? (
            <p className="credential-group-hint">{group.hint}</p>
          ) : null}
          <ul className="credential-list">
            {group.entries.map((credential) => (
              <li key={`${credential.scope}:${credential.id}`}>
                <div className="credential-row">
                  <span
                    aria-hidden="true"
                    className={`readiness-dot ${
                      credential.severity === "expired" || !credential.authenticated
                        ? "fail"
                        : credential.severity === "expiring"
                          ? "warning"
                          : "pass"
                    }`}
                  />
                  <div className="credential-row-text">
                    <strong>{credential.name}</strong>
                    {credential.detail ? (
                      <span
                        className={`credential-expiry ${credential.severity ?? ""}`}
                      >
                        {credential.detail}
                      </span>
                    ) : null}
                  </div>
                  <button
                    className="text-button"
                    disabled={disabled || busyId === credential.id}
                    onClick={() => onAction(credential)}
                    type="button"
                  >
                    {busyId === credential.id
                      ? "Working…"
                      : credential.kind === "aws-profile"
                        ? "Sign in"
                        : "Re-import"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  describeSsoExpiry,
  ssoSeverityFor,
  type CredentialStatus,
} from "../../../shared/credentials";

/**
 * A countdown has to count. Status is read from the main process only on
 * selection changes and after actions, so the remaining time is recomputed
 * here from the deadline instead of going back over IPC to move a number.
 */
function useTick(active: boolean): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return tick;
}

function live(
  credential: CredentialStatus,
  now: Date,
): { detail?: string; severity?: CredentialStatus["severity"] } {
  if (!credential.expiresAt) {
    return { detail: credential.detail, severity: credential.severity };
  }
  const expiresAt = new Date(credential.expiresAt);
  return {
    detail: describeSsoExpiry(
      expiresAt,
      credential.canRenewSilently ?? false,
      now,
    ),
    severity: ssoSeverityFor(expiresAt, now),
  };
}

/**
 * The sidebar offers an action only when there is something to do. A healthy
 * identity needs nothing, and a button that is almost always a no-op teaches
 * people to ignore it. Replacing a working credential stays in Workspace
 * Studio, where it is a deliberate act rather than a glance.
 */
function needsAction(
  credential: CredentialStatus,
  severity: CredentialStatus["severity"],
): boolean {
  return (
    (!credential.authenticated && !credential.expiresAt) ||
    severity === "expiring" ||
    severity === "expired"
  );
}

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
  // Only tick while something is actually counting down.
  const counting = [...user, ...workspace, ...target].some(
    (credential) => credential.expiresAt !== undefined,
  );
  const now = new Date(useTick(counting));

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
            {group.entries.map((credential) => {
              const { detail, severity } = live(credential, now);
              return (
              <li key={`${credential.scope}:${credential.id}`}>
                <div className="credential-row">
                  <span
                    aria-hidden="true"
                    className={`readiness-dot ${
                      severity === "expired" ||
                      (!credential.authenticated && !credential.expiresAt)
                        ? "fail"
                        : severity === "expiring"
                          ? "warning"
                          : "pass"
                    }`}
                  />
                  <div className="credential-row-text">
                    <strong>{credential.name}</strong>
                    {detail ? (
                      <span className={`credential-expiry ${severity ?? ""}`}>
                        {detail}
                      </span>
                    ) : null}
                  </div>
                  {needsAction(credential, severity) ? (
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
                          : "Import"}
                    </button>
                  ) : null}
                </div>
              </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

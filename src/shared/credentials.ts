import { z } from "zod";

/**
 * Credential *references* are manifest-safe pointers. They are inspectable,
 * portable, and renderer-visible. Secret material is never part of a
 * reference; it lives only in the OS-backed credential store and is addressed
 * by reference id and scope.
 */
export const credentialScopeSchema = z.enum(["user", "workspace", "target"]);
export type CredentialScope = z.infer<typeof credentialScopeSchema>;

export const credentialKindSchema = z.enum([
  "aws-profile",
  "aws-role",
  "provider-oauth",
]);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Identifiers use lowercase letters, digits, and single hyphens.",
  );

export const credentialReferenceSchema = z
  .object({
    id: identifier,
    name: z.string().min(1).max(120),
    kind: credentialKindSchema,
    scope: credentialScopeSchema,
    /** Non-secret selection metadata only. */
    region: z.string().min(1).max(64).optional(),
    roleArn: z.string().min(1).max(2048).optional(),
    sourceProfile: z.string().min(1).max(128).optional(),
    providerId: z.string().min(1).max(64).optional(),
    /**
     * Optional model the agent should use with this identity, for example
     * `github-copilot/gpt-5`. Non-secret, and the only way OpsCapsule can make
     * a capsule deterministically use the selected provider.
     */
    model: z.string().min(1).max(200).optional(),
    expectedAccountId: z
      .string()
      .regex(/^\d{12}$/, "An AWS account id is twelve digits.")
      .optional(),
  })
  .strict();

export type CredentialReference = z.infer<typeof credentialReferenceSchema>;

/** Renderer-facing projection. Deliberately identical: none of it is secret. */
export interface CredentialStatus {
  readonly id: string;
  readonly name: string;
  readonly kind: CredentialKind;
  readonly scope: CredentialScope;
  readonly authenticated: boolean;
  readonly expectedAccountId?: string;
  /** For aws-profile references: the host profile credentials come from. */
  readonly sourceProfile?: string;
  /** Human-readable state, such as when a sign-in expires. */
  readonly detail?: string;
  /**
   * The workspace whose manifest declares this reference. A user-scoped
   * credential is global but is still declared somewhere, and actions resolve
   * against the declaring workspace rather than whatever is selected.
   */
  readonly workspaceId?: string;
  /** How prominently the state should be shown. Absent when nothing to say. */
  readonly severity?: SsoSessionSeverity;
  /**
   * When the sign-in stops being usable, as ISO 8601.
   *
   * Sent so the renderer can recompute the remaining time locally. A countdown
   * rendered once goes stale immediately, and re-reading over IPC every few
   * seconds to move a number is wasteful.
   */
  readonly expiresAt?: string;
  readonly canRenewSilently?: boolean;
}

export type SsoSessionSeverity = "ok" | "expiring" | "expired";

/** Amber inside this window, because a sign-in takes a browser round trip. */
export const SSO_EXPIRY_WARNING_MS = 15 * 60_000;

/**
 * Shared so the main process and the renderer describe a session identically:
 * main for the first paint, the renderer for every tick after it.
 */
export function ssoSeverityFor(
  expiresAt: Date,
  now: Date = new Date(),
): SsoSessionSeverity {
  const remainingMs = expiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return "expired";
  }
  return remainingMs < SSO_EXPIRY_WARNING_MS ? "expiring" : "ok";
}

export function describeSsoExpiry(
  expiresAt: Date,
  canRenewSilently: boolean,
  now: Date = new Date(),
): string {
  const remainingMs = expiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    // A refresh token may still rescue this, but saying so would be a guess.
    // If it renews, the next read clears the message.
    return canRenewSilently ? "Renewing or expired" : "Sign-in expired";
  }
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  return hours > 0 ? `Signed in, ${hours}h left` : `Expires in ${minutes}m`;
}

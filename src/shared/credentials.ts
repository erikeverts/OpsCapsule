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
  readonly severity?: "ok" | "expiring" | "expired";
}

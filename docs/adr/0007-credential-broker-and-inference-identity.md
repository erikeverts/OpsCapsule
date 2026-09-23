# ADR 0007: Credential broker and inference identity

- Status: Proposed
- Date: 2026-09-23

## Context

OpsCapsule deliberately refuses to make credentials portable. Imported AWS
configuration is stripped of `aws_access_key_id`, `aws_secret_access_key`, and
`aws_session_token` before it is written beneath a workspace resource directory.
The manifest schema rejects credential-shaped and OpsCapsule-managed environment
names. Agent profiles import configuration but never a credential store such as
OpenCode's `auth.json`. The manifest and its managed resources are returned to
the renderer in full, so anything stored there is renderer-visible by
construction.

Those rules preserve the isolation boundary, but they leave two gaps.

**Provider authentication does not survive the boundary.** Mutable agent state
is isolated per workspace, target, and profile. Authentication state lives
inside that state, so a single user-owned provider identity such as GitHub
Copilot must be re-authenticated separately for development, staging, and
production. Credentials have a different lifecycle and a different sharing
boundary from conversation history, caches, and sessions, but the current model
gives them the narrowest possible scope by accident rather than by decision. The
documented workaround — temporarily repointing a profile at `opencode auth
login`, authenticating, then restoring the real arguments — makes authentication
look like agent runtime configuration.

Worse, the failure is silent and dangerous in the wrong direction. When Copilot
is unauthenticated inside a capsule but the target supplies a working AWS
identity, OpenCode can quietly fall back to Bedrock and bill inference to the
customer's operational account.

**Inference and operational identity are the same identity.** Model inference is
frequently centralised in one account while operational work happens in
customer- or environment-specific accounts. OpsCapsule cannot express this. One
environment is assembled once per session and shared by the agent pane and both
shell panes; adapters may add profile-declared values but OpsCapsule-managed
values always win. Setting `AWS_PROFILE` for inference would therefore redirect
every operational command as well.

Narrowing that override to the agent pane alone does not fix it either. The
agent spawns operational `aws` and `kubectl` children that inherit the agent's
environment. Any AWS environment variable that reaches the agent process reaches
the operational commands it runs. **Environment variables are structurally
incapable of separating these two identities** and this ADR treats that as a
constraint rather than an implementation detail.

Finally, `expectedIdentity.accountId` is currently declared and displayed but
never verified. No component performs an AWS API call of any kind. The UI can
therefore present an account number that the capsule will not actually use.

## Decision

Introduce a **credential broker** owned by the main process. Capsules receive
brokered, short-lived credential material at the moment of use. They never
receive long-lived secrets, and no credential value is written to the manifest,
managed configuration, session logs, or renderer state.

### Credential references

The manifest gains credential *references*, never credential *values*. A
reference is an inspectable, portable pointer:

- a stable id and display name;
- a `kind`, initially `aws-role`, `aws-profile`, or `provider-oauth`;
- a `scope` (below); and
- non-secret selection metadata such as a role ARN, region, expected account id,
  or provider id.

A reference is safe to serialize, safe to show the renderer, and safe to commit
to a workspace manifest. Secret material lives only in the broker's store and is
addressed by reference id.

### Storage

Secrets are stored using Electron `safeStorage`, which is backed by the OS
keychain on macOS and the platform equivalent elsewhere. Encrypted blobs are
written beneath the application's private state directory with `0600`
permissions, in a store keyed by reference id. This avoids an unmaintained
native dependency and keeps the encryption key under OS access control rather
than in application files.

If `safeStorage` reports that encryption is unavailable, the broker refuses to
store a secret rather than silently degrading to plaintext. A reference whose
secret cannot be decrypted fails closed and is reported as unauthenticated.

### Scopes

Sharing scope is explicit and chosen by the user, not inherited by accident:

- `user` — one login reused by every workspace and target; appropriate for a
  personal provider identity such as GitHub Copilot;
- `workspace` — shared by all targets within one workspace, typically a
  customer or engagement boundary; and
- `target` — the current behaviour, retained for anything that must not cross an
  environment boundary.

The scope of a credential is displayed wherever the credential is used. Widening
a scope is an explicit user action, never a migration side effect.

### Brokered delivery, not injection

Credentials are delivered through a **broker helper** rather than an environment
variable or a file written into the capsule. OpsCapsule materialises a named AWS
profile whose `credential_process` invokes the helper. The helper is
authenticated by a per-session, single-target token that is valid only for the
lifetime of that capsule, and it returns short-lived credentials in the standard
`credential_process` JSON form.

This gives several properties that injection cannot:

- no credential is at rest inside the capsule filesystem or environment;
- credentials expire with the session and can be revoked immediately;
- every issuance is attributable to a session, target, and reference; and
- the AWS SDK and CLI already understand the mechanism, so OpsCapsule remains
  free of a bundled AWS SDK and stays agent-agnostic.

Provider OAuth credentials such as Copilot follow the same principle. The broker
materialises the provider's expected credential file into the capsule's
scope-appropriate state directory at launch, with `0600` permissions, and
removes it on teardown. The user's real home directory is never exposed and no
credential file is copied into a workspace resource directory.

### Two named identities, selected by name

The capsule's AWS configuration contains two clearly named profiles:

- the **operational** profile, which remains the default and remains the value of
  `AWS_PROFILE`; and
- the **inference** profile, which is present but never the default.

Shell panes and every operational command the agent runs continue to resolve the
operational identity with no change in behaviour. The inference identity is
selected *by profile name* in adapter-materialised provider configuration, so
selection travels through the model provider's own configuration path instead of
the process environment.

Where an agent supports only environment-based Bedrock configuration and cannot
name a profile, the fallback is a loopback signing proxy: the broker terminates
the agent's Bedrock requests on localhost, signs them with the inference
identity in the main process, and forwards them. The agent then holds an
endpoint, not a credential. The fallback is explicitly preferred over exporting
inference credentials into the agent environment, because the latter would leak
into every child process the agent spawns.

An inference identity is optional. When none is configured, behaviour is
unchanged and Bedrock continues to use the target identity, which remains a
legitimate configuration.

### Verification and display

The broker gains an `identity` readiness check — the first AWS API call in the
project. It resolves each configured identity and compares the returned account
against `expectedIdentity.accountId`. A mismatch fails the check and blocks
launch; an unverifiable identity is a warning, because an offline host is not
the same as a wrong account.

The check runs in the main process. Only a verdict, an account id, a scope, and
a display name cross the IPC boundary. Tokens, secrets, role session material,
and file paths to credential stores do not.

The UI shows both identities together with their different purposes, using
distinct labels for operational and inference use. Two account numbers presented
without that distinction would be actively misleading.

### Authentication lifecycle

Agent profiles gain an explicit authentication status and login and logout
actions, replacing the argument-rewriting workaround. Login runs the provider's
own flow inside the capsule boundary, at the chosen scope. Logout removes the
stored secret for that reference. Revocation of an inference identity has no
effect on the target connection, and revocation of a target connection has no
effect on an inference identity; the two lifecycles are independent by
construction.

## Consequences

- A user-owned provider identity can be authenticated once and reused at an
  intentional scope, instead of once per target by accident.
- Inference can be billed to a central account while operational work stays in
  the customer account, without any risk of an operational command running
  against the inference account.
- The silent fallback from an unauthenticated Copilot to the customer's Bedrock
  account becomes visible before launch rather than discovered in a bill.
- `expectedIdentity` becomes a verified claim rather than a displayed assertion.
- OpsCapsule performs its first outbound cloud API call, which introduces
  network failure and latency into the readiness path. The check must degrade to
  a warning rather than block work on an offline host.
- The broker helper is a new trust-sensitive executable surface. Its token
  handling, single-target binding, and lifetime need dedicated tests.
- `safeStorage` ties stored secrets to the machine and OS user account. Secrets
  do not migrate with a workspace manifest, which is intended, but it must be
  clear in the UI that a manifest alone does not carry authentication.
- The loopback signing proxy, if implemented, places OpsCapsule on the inference
  data path. It must not log request or response bodies.
- Credential storage, provider OAuth brokering, AWS role brokering, identity
  verification, and the loopback proxy are separable slices and are expected to
  land incrementally rather than as one change.

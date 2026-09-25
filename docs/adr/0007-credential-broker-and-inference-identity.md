# ADR 0007: Credential broker and inference identity

- Status: Proposed
- Date: 2026-09-23
- Spike: `src/main/credentials/`, `tests/credential-broker-spike.test.ts`

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

- `user` — one login reused by every workspace and target; the expected scope
  for a personal provider identity such as GitHub Copilot, and for a central
  Bedrock inference account;
- `workspace` — shared by all targets within one workspace, typically a
  customer or engagement boundary; and
- `target` — the current behaviour, retained for anything that must not cross an
  environment boundary.

The two identities normally sit at different scopes, and that asymmetry is the
point of the design. A **global, user-scoped inference identity** is
authenticated once and reused everywhere, while the **operational identity stays
target-scoped** so that development, staging, and production never share one.
Scope is a property of the credential reference, so a workspace-scoped inference
account remains expressible for an engagement that bills its own inference.

The scope of a credential is displayed wherever the credential is used. Widening
a scope is an explicit user action, never a migration side effect.

### Brokered delivery, not injection

**Authentication happens in the main process, outside the sandbox.** The main
process owns the credential store, performs every provider login and role
assumption, and mints a short-lived session. A capsule never holds a long-lived
secret and never performs authentication itself.

What enters the capsule is only the session. OpsCapsule materialises a named AWS
profile whose `credential_process` invokes a **broker helper**. That helper is a
thin client: it carries no credential, reads its session token and credential
reference from its environment, relays them to the main process over a unix
socket, and writes the returned short-lived credentials to stdout in the
standard `credential_process` JSON form. The token is bound to one session and
to an explicit set of credential references, so a capsule cannot request a
credential its target does not use.

This gives several properties that injection cannot:

- no credential is at rest inside the capsule filesystem or environment, for
  consumers that support pull delivery;
- credentials expire with the session and can be revoked immediately, because
  the issuing authority is outside the boundary and stays under our control;
- every issuance is attributable to a session, target, and reference; and
- the AWS SDK and CLI already understand the mechanism, so OpsCapsule remains
  free of a bundled AWS SDK and stays agent-agnostic.

### The isolation cost of a broker channel

A capsule currently has **no channel to the main process at all**.
`buildSandboxRuntimeSettings` sets `allowUnixSockets: []`,
`allowAllUnixSockets: false`, and `allowLocalBinding: false`. The broker
architecture above is therefore not implementable without deliberately opening
one, and that is a change to the isolation boundary rather than an
implementation detail.

The decision is to allow **exactly one unix socket per capsule session**: the
absolute path of the socket owned by that session, and nothing else.
`allowAllUnixSockets` and `allowLocalBinding` stay `false`. The spike confirms
that only an absolute path is honoured — glob patterns such as
`**/broker.sock` are not — which conveniently forces the narrowest possible
allowance rather than a pattern that could match a future attacker-chosen path.

This is a real reduction in isolation and is accepted knowingly. The socket is
the capsule's only route out to the application, so its protocol must stay
minimal, must be request/response only, must never accept a path or command from
the capsule, and must be treated as an untrusted input boundary with the same
seriousness as the renderer IPC surface.

### Delivery is provider-specific; the broker is not

`credential_process` is an AWS mechanism. GitHub Copilot has no equivalent: the
agent simply reads a credential file. Delivery is therefore a pluggable
adapter, selected by the credential's kind, in the same way the project already
uses cloud adapters and runtime adapters. The broker core - authority, scope,
audit, socket lifecycle - stays provider-neutral and returns an
already-formatted payload, so adding a provider never means editing the broker.

Two delivery shapes exist, and the difference is a security difference rather
than a detail:

- **pull**: the consumer spawns the helper when it needs a credential, as with
  AWS `credential_process` and Claude Code's `awsCredentialExport`. Nothing is
  stored inside the capsule, but the capsule needs a live channel out.
- **materialize**: the consumer only reads a file, as with Copilot through
  OpenCode. The broker writes it into scope-appropriate agent state at launch
  with `0600` permissions and removes it on teardown. The secret is briefly at
  rest inside the boundary, which is weaker, but the capsule needs no channel
  at all.

Because the channel is opened per delivery transport rather than whenever any
credential exists, a capsule whose credentials are all materialized keeps
`allowUnixSockets` empty and opens no hole in the sandbox. A materialized
credential is never copied into a workspace resource directory, and the user's
real home directory is never exposed.

### Two named identities, selected by name

The capsule's AWS configuration contains two clearly named profiles:

- the **operational** profile, which remains the default and remains the value of
  `AWS_PROFILE`; and
- the **inference** profile, which is present but never the default and is never
  named anywhere in the process environment.

Shell panes and every operational command the agent runs continue to resolve the
operational identity with no change in behaviour. The inference identity is
selected through the agent's own configuration, so selection travels through the
model provider's configuration path instead of the process environment.

Both supported adapters provide a suitable mechanism, and this was verified
against vendor documentation rather than assumed:

- **OpenCode** accepts `provider."amazon-bedrock".options.profile`, selecting an
  AWS profile by name, and documents that configuration-file options take
  precedence over environment variables.
- **Claude Code** provides `awsCredentialExport`, a command returning credential
  JSON, documented for precisely this case: "when your Amazon Bedrock account
  requires cross-account credentials that differ from the ones the default
  provider chain would resolve."

A single broker payload satisfies both consumers. AWS `credential_process`
requires `Version: 1` with top-level credential keys, and Claude Code documents
that it also accepts that same flat shape, so the helper needs no per-consumer
branching.

For an adapter that offers neither mechanism, the fallback is a loopback signing
proxy: the broker terminates the agent's Bedrock requests on localhost, signs
them with the inference identity in the main process, and forwards them. This is
now a contingency for unknown future adapters rather than part of the primary
design. It remains strictly preferable to exporting inference credentials into
the agent environment, because those would reach every child process the agent
spawns.

An inference identity is optional. When none is configured, behaviour is
unchanged and Bedrock continues to use the target identity, which remains a
legitimate configuration.

### Helper constraints

The helper runs inside the capsule sandbox and is subject to constraints that
the consuming agents impose:

- **It must never read stdin.** Claude Code times out credential-chain
  resolution after 60 seconds and names "a `credential_process` helper that
  waits for input it can't receive" as a known failure mode. An interactive
  helper would hang the agent rather than fail it.
- **It must take its request from the environment, not argv.** Process arguments
  are readable by other processes on the machine, which inside a capsule
  includes the agent and both shell panes.
- **Its output must be treated as secret.** Claude Code captures
  `awsCredentialExport` output silently and does not display it; OpsCapsule must
  not log it either.
- **STS must be reachable.** Claude Code independently calls
  `GetCallerIdentity` before refreshing credentials. Under a capsule network
  policy of `deny`, that call fails, so any target using Bedrock needs an
  allowlist entry for STS.

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
actions, replacing the argument-rewriting workaround.

**Login runs in the main process, never inside a capsule.** The main process
opens the provider's own flow - a browser redirect or a device code - receives
the result, and writes it to the credential store at the chosen scope. Three
reasons make this the only coherent option:

- a capsule must never hold a long-lived secret, and the artefact a login
  produces, such as an OAuth refresh token, is exactly that;
- a capsule is bound to one target, so a login performed inside one could not
  produce a `user`-scoped credential reusable everywhere, which is the original
  complaint in issue #6; and
- revocation and rotation have to be controllable from outside the boundary.

What reaches a capsule is therefore always the shortest-lived artefact that
works. For pull delivery that is a brokered session. For materialize delivery
it is a short-lived access token written at launch, while the refresh token
stays in the main process and is used there to renew it. A capsule never sees
the refresh token.

Logout removes the stored secret for that reference. Revocation of an inference
identity has no effect on the target connection, and revocation of a target
connection has no effect on an inference identity; the two lifecycles are
independent by construction.

## Spike

A spike accompanies this ADR in `src/main/credentials/` with its proof in
`tests/credential-broker-spike.test.ts`. It is deliberately not wired into the
launch path. What it establishes:

- **The main process is the only credential holder, and the capsule can reach
  it.** With the settings OpsCapsule ships today the helper is *blocked*: there
  is no channel out of the capsule. With exactly one per-session unix socket
  allowed, the helper reaches the authority and returns a credential minted
  outside the boundary. Both directions are covered, so the isolation cost of
  this ADR is measured rather than assumed.
- **One payload serves both consumers**, matching the AWS `credential_process`
  contract and Claude Code's accepted flat shape.
- **The authority fails closed** on a wrong session token, on a credential
  reference outside the session's scope, and after revocation.
- **The environment never names the inference identity**, which is the
  invariant that keeps operational commands on the target identity.

The spike also closed a bypass that the existing design did not cover. The
manifest schema rejects `AWS_*` names in `profile.environment`, but a managed
Claude Code `settings.json` carries its own `env` block and
`.claude/settings.json` is an allowed managed destination. An `AWS_PROFILE`
placed there would not be caught by the schema. The spike confirms that
`inspectAgentConfigurationFile` does flag it as an `identity` danger, which is
already promoted to a hard failure at both readiness and launch — and that the
legitimate OpenCode Bedrock profile selection is *not* flagged, so the guard
does not block the mechanism this ADR depends on. Both behaviours were
previously untested and are now regression-covered.

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
- The loopback signing proxy, if it is ever needed for a future adapter, would
  place OpsCapsule on the inference data path. It must not log request or
  response bodies.
- Bedrock-backed targets cannot run with a `deny` network policy unchanged,
  because Claude Code's own STS `GetCallerIdentity` call must succeed. This
  couples credential work to the network policy model.
- The capsule gains its first route back to the application, but only when a
  pull-based credential is in use. `allowUnixSockets` moves from an empty list
  to one per-session path, which is a deliberate reduction in isolation and
  makes the broker socket a new untrusted input boundary requiring the same
  scrutiny as renderer IPC. Capsules with no pull-based credential are
  unaffected.
- A materialize-delivered credential should be a short-lived access token
  rather than the refresh token, so renewal has to run in the main process and
  re-materialize on expiry. A capsule that outlives the access token needs the
  file refreshed underneath it.
- Materialized provider credentials are briefly at rest inside the capsule.
  That is a genuine weakening relative to the pull path and is accepted only
  because the consuming agents offer no alternative. Teardown removal is
  therefore load-bearing rather than tidiness.
- Issue #8, which asks the UI to distinguish configured from active isolation,
  now has a second dimension to report: whether a capsule has a broker channel
  open.
- Credential storage, provider OAuth brokering, AWS role brokering, identity
  verification, and the loopback proxy are separable slices and are expected to
  land incrementally rather than as one change.

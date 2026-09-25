# Credentials

OpsCapsule never stores credentials in a workspace manifest, in managed
configuration, or in renderer state. Secrets live in an OS-backed store and are
delivered to a capsule at launch or at point of use. The design and its
trade-offs are recorded in
[ADR 0007](adr/0007-credential-broker-and-inference-identity.md).

Credentials are managed in **Workspace Studio → Credentials**: declare a
reference, see whether it is authenticated, supply or replace its secret, and
sign out. A developer CLI is also available for scripting and troubleshooting.

Authentication always runs in the main process. A capsule never performs a
login and never holds a long-lived secret; it receives a brokered session or a
short-lived token at launch.

## Concepts

A workspace declares credential **references**. A reference is a pointer, never
a secret: it is safe to commit and safe to show the renderer.

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier used by targets and by the broker |
| `kind` | `aws-profile`, `aws-role`, or `provider-oauth` |
| `sourceProfile` | For `aws-profile`, the host AWS profile to mint from |
| `scope` | `user`, `workspace`, or `target` |
| `providerId` | For `provider-oauth`, the consuming agent, e.g. `opencode` |

Scope decides sharing. A `user`-scoped reference is authenticated once and
reused by every workspace and target, which is the expected shape for a central
Bedrock account or a personal Copilot login. A `target`-scoped reference is
partitioned per workspace and target so environments never share one.

## Two kinds of credential, two flows

**AWS profiles store nothing.** An `aws-profile` reference names a profile that
already exists on your host. When a capsule asks for credentials, the main
process runs the AWS CLI's own resolution for that profile and passes the
result in. The SSO cache, the role chain, and any long-lived keys stay outside
the capsule; only the resulting short-lived session goes in. Nothing is written
to the OpsCapsule credential store.

**Provider logins are stored.** A `provider-oauth` reference holds a secret,
encrypted by the operating system, because there is no host-side resolver to
call.

### Adding an AWS identity

1. Workspace Studio → **Credentials** → **Add credential**.
2. Set kind to **AWS session** and pick the **AWS profile** from the list.
3. **Save changes.** Authentication acts on the saved manifest, so a credential
   that exists only in the draft shows *Not saved* and its button stays
   disabled. The studio stays open after saving.
4. The status line shows whether that profile currently resolves credentials.
   If its SSO session has expired, choose **Sign in**; the browser flow runs in
   the main process, never inside a capsule.
5. Select it as a target's **operational credential**.

There is no file to choose and no secret to paste. If you expected a file
picker here, that was an earlier design and it was wrong.

### Adding a provider login, such as GitHub Copilot

1. Authenticate once on the host: run `opencode` and `/connect`, then choose
   GitHub Copilot and complete the device flow.
2. **Add credential**, set kind to **Provider login**, and set the provider to
   `opencode`.
3. Choose **Import credential** and select
   `~/.local/share/opencode/auth.json`.
4. Select it as the workspace **inference identity**.
5. Choose a Copilot model in the profile's `opencode.json`, for example
   `"model": "github-copilot/gpt-5"`. The credential supplies authentication;
   which model to use is ordinary agent configuration.

The login is written into the capsule's agent state at launch and removed on
teardown. Unlike an AWS session, it is briefly at rest inside the capsule,
because the agent reads it from a file and there is nothing to call.

OpenCode stores a Copilot login with a zero expiry and mints a Copilot API
token from its refresh token on demand, so that refresh token is delivered with
it. Removing it would hand the capsule a credential that fails on first use.

**Claude Code cannot use GitHub Copilot.** Its model backends are the Anthropic
API, Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform,
Microsoft Foundry, Mantle, and Anthropic-compatible gateways. Use Bedrock for a
Claude Code inference identity.

**Sign out** removes a stored secret and keeps the reference. It is only shown
for credentials that store one.

## Storing a credential from the CLI

The CLI is equivalent to the UI and useful for scripting.

```bash
npm run credentials -- help
```

The CLI stores secrets, so it applies to provider logins. AWS profiles need no
stored secret and are configured entirely in the UI.

A central, user-scoped inference identity for Copilot through OpenCode:

```bash
npm run credentials -- set \
  --id central-inference --scope user \
  --kind provider-oauth --provider opencode \
  --file ~/.local/share/opencode/auth.json
```

Check and remove:

```bash
npm run credentials -- status --id central-inference --scope user
npm run credentials -- remove --id central-inference --scope user
```

The CLI prints the userData directory it is using. That must match the running
application; if it prints `Electron` rather than the product name, the name
alignment has regressed.

## Declaring the references in a workspace

```yaml
credentials:
  - id: central-inference
    name: Central Bedrock
    kind: provider-oauth
    scope: user
    providerId: opencode
  - id: target-operational
    name: Customer production
    kind: aws-profile
    scope: target
    sourceProfile: customer-production
    region: eu-west-1
inferenceCredential: central-inference
targets:
  - id: production
    operationalCredential: target-operational
    # ...
```

A target may not reuse the inference credential as its operational identity,
and unknown references fail validation.

## What happens at launch

Delivery depends on the credential kind, because consumers differ:

- **pull** - AWS `credential_process` and Claude Code `awsCredentialExport`
  spawn a generated helper when they need a credential. Nothing is stored in
  the capsule, but the capsule gets one unix socket to the main process.
- **materialize** - a provider login such as Copilot is written into
  scope-appropriate agent state at launch with `0600` permissions and removed
  on teardown. The secret is briefly at rest inside the capsule, but no channel
  is opened at all. Refresh tokens are stripped before the file is written, so
  a capsule only ever receives the short-lived access token.

A capsule therefore only receives a broker socket when something actually
pulls. With no credentials, or with only materialized ones,
`allowUnixSockets` stays empty and the isolation boundary is unchanged.

For AWS, the capsule gets two named profiles. The operational identity is the
default profile and remains the value of `AWS_PROFILE`. The inference identity
is named `opscapsule-inference`, is never the default, and is never named in
the environment, because any `AWS_*` variable reaching the agent also reaches
the operational commands it spawns.

**OpsCapsule selects the inference identity for the agent.** Configuring the
workspace is enough; nothing needs editing inside the capsule.

| Agent | What OpsCapsule writes |
| --- | --- |
| OpenCode | `provider."amazon-bedrock".options.profile` in `opencode.json` |
| Claude Code | `awsCredentialExport` in `settings.json`, pointed at the broker |
| Generic command | `OPSCAPSULE_INFERENCE_PROFILE` and `OPSCAPSULE_INFERENCE_REGION` |

Imported managed configuration is merged, not replaced, so a profile can still
bring its own settings. The environment deliberately carries only the profile
name and region: it is shared with both shell panes, so it must not hand every
shell a command that can spend the inference account.

## Verifying

```bash
# Confirm the secret is encrypted at rest and not world-readable.
ls -l "$HOME/Library/Application Support/OpsCapsule/credentials/user/"
```

A stored secret begins with the `v10` OSCrypt marker and is mode `0600`. The
plaintext must not appear in the file.

## Limitations

- `aws-role` references are refused rather than silently treated as long-lived
  credentials. STS role assumption is a later slice; use `aws-profile` with a
  profile that already assumes the role.
- Resolving an AWS profile requires the AWS CLI on the host. A missing CLI is
  reported as a failure to authenticate.
- Authenticate imports a secret you already obtained, for example by running
  `opencode auth login` on the host once. Running the provider's own device
  code or browser flow from the main process is a later slice.
- Identity verification against `expectedAccountId` is not implemented, so the
  account shown in the UI is still a declared value rather than a verified one.
- The broker transport uses `curl --unix-socket`, which is present by default
  on macOS and effectively every Linux distribution. A missing `curl` currently
  fails when a credential is requested rather than at readiness.

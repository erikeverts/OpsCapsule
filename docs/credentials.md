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
| `scope` | `user`, `workspace`, or `target` |
| `providerId` | For `provider-oauth`, the consuming agent, e.g. `opencode` |

Scope decides sharing. A `user`-scoped reference is authenticated once and
reused by every workspace and target, which is the expected shape for a central
Bedrock account or a personal Copilot login. A `target`-scoped reference is
partitioned per workspace and target so environments never share one.

## Storing a credential from the UI

1. Open the workspace in Workspace Studio and select **Credentials**.
2. **Add credential**, then set its name, kind, and scope.
3. Choose **Authenticate** and select the file holding the secret.
4. Select the credential as the workspace **inference identity**, or as a
   target's **operational credential**.

The status line shows whether a secret is held in the OS keychain. **Sign out**
removes the secret and keeps the reference.

## Storing a credential from the CLI

The CLI is equivalent to the UI and useful for scripting.

```bash
npm run credentials -- help
```

A central, user-scoped inference identity for Copilot through OpenCode:

```bash
npm run credentials -- set \
  --id central-inference --scope user \
  --kind provider-oauth --provider opencode \
  --file ~/.local/share/opencode/auth.json
```

A target-scoped operational AWS identity:

```bash
cat > /tmp/aws-session.json <<'JSON'
{"accessKeyId":"ASIA...","secretAccessKey":"...","sessionToken":"...",
 "expiration":"2026-01-01T00:00:00Z"}
JSON

npm run credentials -- set \
  --id target-operational --scope target \
  --kind aws-profile --workspace atlas --target production \
  --file /tmp/aws-session.json
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
is named `opscapsule-inference` and is never the default and never named in the
environment, because any `AWS_*` variable reaching the agent also reaches the
operational commands it spawns. Selecting it is done in agent configuration:

```json
{
  "provider": {
    "amazon-bedrock": {
      "options": { "profile": "opscapsule-inference", "region": "us-east-1" }
    }
  }
}
```

## Verifying

```bash
# Confirm the secret is encrypted at rest and not world-readable.
ls -l "$HOME/Library/Application Support/OpsCapsule/credentials/user/"
```

A stored secret begins with the `v10` OSCrypt marker and is mode `0600`. The
plaintext must not appear in the file.

## Limitations

- `aws-role` references are refused rather than silently treated as long-lived
  credentials. STS role assumption is a later slice.
- Authenticate imports a secret you already obtained, for example by running
  `opencode auth login` on the host once. Running the provider's own device
  code or browser flow from the main process is a later slice.
- Identity verification against `expectedAccountId` is not implemented, so the
  account shown in the UI is still a declared value rather than a verified one.
- The broker transport depends on `nc` on macOS and `socat` on Linux. A missing
  transport currently fails when a credential is requested rather than at
  readiness.

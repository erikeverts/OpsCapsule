# Extension security model

This document is the threat model for the extension contract in
[ADR 0011](adr/0011-secure-extension-contract.md). The current implementation is
a schema and type contract only. OpsCapsule does not yet discover or execute
extension packages.

## Security objective

Installing or enabling an extension must not silently give a capsule, extension,
or unrelated workspace more authority than the user explicitly approved. The
core must preserve workspace and target separation even when extension input is
malformed, compromised, or hostile.

The extension system is not intended to make arbitrary third-party native code
safe. An executable extension needs an independently enforced host sandbox in
addition to the capsule sandbox.

## Protected assets

- Files outside a target's configured roots
- Other workspaces' and targets' configuration and persistent state
- Long-lived credentials, signing keys, SSH/GPG agents, and credential caches
- The host Docker daemon and other privileged Unix sockets
- Electron main-process authority and renderer IPC
- Capsule policy, session identity, and audit history
- Extension approval records and verified package metadata
- Availability of the application and running capsules

## Trust zones

| Zone | Trust level | Rule |
| --- | --- | --- |
| OpsCapsule core | Trusted enforcement code | Owns policy, lifecycle, grants, brokers, IPC, and audit |
| Built-in extension | Trusted application code | Still receives only its declared host context so the contract is testable |
| External extension package | Untrusted input | Manifest and files require verification; no execution in slice 1 |
| Future extension process | Untrusted code | Must be a separate OS-sandboxed process with a narrow protocol |
| Renderer/extension UI | Untrusted input boundary | No Node integration or direct main-process APIs |
| Capsule process tree | Untrusted target workload | Receives only the effective target policy and exact broker endpoints |
| Remote services | Untrusted network peers | Reachable only through approved network capabilities |

The user's decision to install an extension changes trust policy but does not
turn the extension into core code. Publisher signatures prove origin and
integrity, not safety.

## Threats and required controls

### Arbitrary code in the Electron process

**Threat:** a package entry point imported into the main process can read the
user's files, credentials, application state, and every active capsule.

**Controls:** `v1alpha1` accepts only `execution.mode: built-in`; no JavaScript
entry point exists. A future executable extension runs out of process under an
OS sandbox. A future UI runs in an isolated renderer without Node integration.

### Permission laundering

**Threat:** a manifest parses successfully and the UI presents that as approval,
or an extension asks a broad broker to perform an operation not visible in its
permission list.

**Controls:** parsing, package trust, enablement, permission grant, and activation
are distinct states. Every sensitive broker call identifies a permission id and
activation scope. The host checks both on every call. There is no generic
filesystem or command escape hatch.

### Cross-target confused deputy

**Threat:** an extension active for development reuses a handle, socket, setting,
or credential belonging to production or another workspace.

**Controls:** activation contexts include workspace, target, and capsule session
ids. Handles are minted for one activation and cannot be reopened by path.
Persistent state is partitioned by scope. Broker authorization uses the context
recorded by the core, never identifiers asserted by an extension request.

### Filesystem escape and link attacks

**Threat:** bundle paths contain `..`, absolute paths, or symlinks; extension
state or target roots are swapped after approval; a plugin requests the user's
home directory directly.

**Controls:** manifest bundle paths are normalized relative paths. Package
extraction must reject traversal, special files, and unsafe symlinks. Manifests
cannot request arbitrary host paths. Target-directory access is resolved and
canonicalized by the existing core and cannot exceed each directory's declared
access. State is returned as a scoped handle, not an extension-chosen path.

### Command and argument injection

**Threat:** a manifest declares `/bin/sh`, embeds shell syntax, changes `PATH`, or
uses an allowed executable with dangerous unreviewed arguments.

**Controls:** manifests declare command names, not paths or shell expressions.
The core resolves executables. Each command broker defines its accepted argument
shape, environment, working-directory choices, timeout, and output limits. No
broker uses a shell to join arguments.

### Network pivot and metadata access

**Threat:** an extension uses network permission to reach localhost, cloud
metadata, another capsule, internal services, or arbitrary public destinations.

**Controls:** network permissions are explicit `deny`, `allowlist`, or `public`
requests. A valid request is still subject to core policy. Local, link-local,
private, metadata, and Unix-socket destinations remain denied unless a separate
capability explicitly covers the endpoint. DNS resolution and redirects must be
checked against the effective policy, not only the original hostname.

### Credential and agent exfiltration

**Threat:** an extension reads a credential value, host SSH/GPG agent, login
cache, or another scope's credential and copies it to a file or remote service.

**Controls:** the manifest can request only brokered credential delivery by kind
and scope. It cannot contain a value or request a credential-store path. The
core preserves the existing pull/materialize distinction and never exposes a
general credential API. SSH and GPG require dedicated brokers with identity,
operation, lifetime, and audit restrictions; a raw host agent socket is not an
acceptable implementation.

### Socket authority escalation

**Threat:** a plugin exposes a shared Docker or agent socket whose authority is
larger than the target filesystem grant.

**Controls:** a socket permission contains a logical id, never a path. The core
chooses an exact target/session-owned path and decides whether the service behind
it has acceptable authority. Wildcard and shared-daemon socket grants remain
forbidden.

### UI spoofing and unsafe actions

**Threat:** an extension imitates OpsCapsule security UI, labels a destructive
action as harmless, or injects HTML with main-process access.

**Controls:** common UI is rendered by the core from typed contributions. Actions
declare risk, but core policy decides confirmation and presentation. A future
custom view is visually identified as extension content, isolated, CSP-bound,
and connected only through a versioned message protocol.

### Malicious or compromised updates

**Threat:** an update changes code, publisher, or permissions while retaining an
old approval.

**Controls:** approval is bound to extension id, exact version, manifest digest,
activation scope, and granted permission subset. Integrity is checked before
activation. Permission expansion requires new consent. Automatic rollback never
restores a binary whose digest is no longer trusted.

### Denial of service

**Threat:** an extension loops, floods readiness reports, starts unbounded
processes, fills disk, or prevents capsule shutdown.

**Controls:** broker requests have size, concurrency, timeout, output, and state
quotas. Activation and deactivation are bounded. Required services may fail one
capsule launch; optional sources degrade independently. The core can revoke an
activation without cooperation from the extension process.

## Permission review rules

- Requests are shown by capability and scope, not as vague "access your data"
  language.
- `public` network, `declared` target directories, brokered credentials, socket
  exposure, and destructive actions receive prominent treatment.
- Enabling at application scope does not imply workspace or target consent.
- A permission not understood by the running host causes rejection.
- A denied optional permission remains denied; it is not replaced with a weaker
  but broader fallback.
- Revocation affects new calls immediately and terminates resources that depend
  on the grant.

## Required audit events

Later implementation slices must record, without secret values:

- install, verification result, update, disable, and uninstall;
- permission request, approval, denial, expansion, and revocation;
- activation, failure, deactivation, and forced termination;
- command execution identity and exit status;
- credential issuance metadata;
- socket exposure and removal; and
- destructive action confirmation and result.

Logs are scoped and size-bounded. Command output, environment values, credential
payloads, tokens, and document contents are not audit fields.

## Residual risk

Built-in extensions are compiled into the trusted application and can still
contain ordinary application vulnerabilities. The contract improves separation,
reviewability, and future migration; it does not sandbox built-in code.

An external executable extension remains code chosen by the user. OS sandboxing
reduces its authority but cannot make every parser, kernel interface, or remote
service safe. Native extensions and arbitrary install scripts should remain out
of scope until the isolated process model and package-verification pipeline have
received a dedicated security review.

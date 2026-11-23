# ADR 0011: Secure extension contract

- Status: Accepted
- Date: 2026-11-18
- Implementation: `src/shared/extensions.ts`
- Security analysis: [`docs/extension-security.md`](../extension-security.md)

## Context

OpsCapsule exists to keep customer, project, and environment contexts separate.
That isolation boundary is broadly useful, but many capabilities built around it
are use-case dependent: target-owned container engines, SSH and GPG agents,
ticket and source-control integrations, task lists, context sources, and future
agent adapters.

Implementing every capability directly in the application would couple the
release cycle of the isolation core to every integration. It would also make the
main process an increasingly large collection of credential, network, process,
and filesystem adapters. Conversely, loading arbitrary npm packages into the
Electron main process would give an extension the user's full authority while a
permissions UI falsely implied containment.

The application therefore needs an extension boundary, but that boundary must
not let an extension define, interpret, or weaken its own permissions.

## Decision

OpsCapsule adopts a versioned extension contract. The application core remains
the policy enforcement point. Extensions describe contributions and request
capabilities; the core validates those requests, records user grants, brokers
sensitive operations, compiles the effective capsule policy, and owns all
lifecycle transitions.

The initial public vocabulary is represented by the strict Zod schemas in
`src/shared/extensions.ts`. Unknown fields are rejected rather than stripped so
that a misspelled or future permission can never be mistaken for an effective
grant.

### Core-owned invariants

Extensions cannot replace these core responsibilities:

- workspace, target, and capsule identities;
- filesystem, network, and Unix-socket policy compilation;
- terminal and agent process ownership;
- credential storage, scoping, and delivery;
- permission approval, reduction, and revocation;
- extension package verification and lifecycle state;
- readiness aggregation and security-relevant audit events; or
- the distinction between enforced and context-only isolation.

An extension manifest is an untrusted request. Successfully parsing one means
only that OpsCapsule understands its vocabulary. It does not mean the extension
is trusted, compatible, installed, enabled, or authorized.

### Versioned contracts

An extension manifest uses:

```yaml
apiVersion: opscapsule.dev/v1alpha1
kind: Extension
```

The callable host boundary is versioned independently:

```yaml
compatibility:
  hostApi: opscapsule.dev/extension-host/v1alpha1
```

Manifest evolution and host behaviour can therefore move independently. A host
must reject a version it does not implement. It must never guess at the meaning
of a newer permission or contribution.

Extension ids are stable, publisher-qualified identifiers such as
`dev.opscapsule.colima`. Contribution and permission ids are local to that
extension and unique across their respective extension-wide namespaces.
Target-service contributions name a separate versioned contract, such as
`opscapsule.dev/container-runtime/v1alpha1`, so implementations can be replaced
without making provider-specific fields part of the workspace core.

### Contributions

The first manifest contract can declare:

- schema-driven settings;
- readiness checks;
- actions with `read`, `write`, or `destructive` risk;
- task sources;
- agent-context sources; and
- target services implementing a named, versioned contract.

These declarations reserve stable ids and tell the core what UI and lifecycle
surfaces exist. They do not add renderer code, Electron IPC handlers, or host
authority.

### Permission requests

Host and capsule permissions are separate.

Host requests cover only named capability classes:

- private extension state at application, workspace, or target scope;
- execution of a declared command name;
- denied, allowlisted, or public network access;
- access to target directories, capped at their already-declared access;
- brokered credential delivery by credential kind.

Capsule requests cover only:

- an exact target-scoped socket chosen and owned by the core; and
- the names of target-scoped environment variables whose values the core
  supplies.

The manifest cannot request arbitrary host paths, literal socket paths, shell
expressions, environment values, or credential values. `targetDirectories:
declared` can preserve a directory's read-only/read-write declaration but can
never upgrade it.

Some valid requests may still be refused. Reserved environment names, private
or metadata network destinations, dangerous command arguments, incompatible
scope, and policy conflicts are authorization decisions made after schema
validation.

Permission approval is bound to all of the following:

- extension id and exact version;
- a verified manifest digest;
- activation scope;
- the specific granted subset of requested permissions.

An update that changes the digest or expands permissions cannot inherit approval
silently. Removing a requested permission may be applied without expanding
authority.

### Lifecycle and scope

Installation and activation are distinct:

```text
package verified -> installed -> disabled
                               -> enabled
                                  -> activating -> active
                                                -> failed
                                  <- deactivating <-
```

- **Installed** is global and means only that a verified package and manifest
  are recorded.
- **Enabled** makes an extension eligible at an explicitly selected
  application, workspace, or target scope.
- **Active** is a runtime state. Target services normally activate for one
  capsule session and receive that capsule's complete workspace, target, and
  session identity.
- **Disabled/uninstalled** revokes future activation. A running activation is
  stopped and its short-lived grants are revoked before removal completes.
- **Failed** is isolated to the activation scope. A required target service may
  block capsule launch; a task source must not.

Application enablement does not implicitly enable every workspace. Workspace
enablement does not implicitly authorize every target. The effective state is
the intersection of installation, compatibility, explicit enablement, settings,
and current permission grants.

Extension state follows the same partitioning:

```text
extensions/<extension-id>/global/
workspaces/<workspace-id>/extensions/<extension-id>/
workspaces/<workspace-id>/targets/<target-id>/extensions/<extension-id>/
```

Those are conceptual ownership paths, not paths supplied to extension code. The
host returns scoped handles through capability-specific brokers.

### Host API

The slice-1 callable API is deliberately small. It provides a validated context
bound to the exact extension version, manifest digest, activation identity, and
granted permissions. It permits reading schema-validated settings and reporting
a declared readiness result.

There is no general `fs`, `spawn`, `fetch`, Electron IPC, credential, or socket
method. Capability-specific brokers will be added only alongside an implemented
built-in extension and must check the permission id and activation scope on every
call. A generic "run anything" or "open any path" method is not an acceptable
future extension to the API.

### Execution and UI in this slice

The `v1alpha1` schema accepts only `execution.mode: built-in`. A built-in is
compiled with OpsCapsule and registered by id. This lets the next slice put the
existing Colima feature behind the contract without creating a third-party code
loading path.

This slice does not discover, install, execute, or render an extension. In
particular it does not:

- import a JavaScript entry point;
- run extension code in Electron's main or renderer process;
- install npm dependencies or package scripts;
- render an extension-provided React bundle or HTML document; or
- treat the self-declared publisher field as proof of identity.

External declarative bundles and isolated executable extensions require later
ADRs. Rich UI, if introduced, must use a sandboxed renderer with no Node
integration and a separate versioned message protocol. Settings and common
status/task views should remain schema-driven wherever possible.

### Package trust and updates

The manifest's `publisher` is display metadata. Trust comes from installation
evidence held outside the manifest: content digest, signature or provenance,
source, and user approval. A future package store must pin exact versions,
verify every file against the recorded digest, reject symlinks or traversal,
and avoid install scripts.

Developer-mode side loading must be visibly distinct, disabled by default, and
must not make an unsigned package appear verified. Signing establishes package
origin and integrity; it does not make requested permissions safe.

## Consequences

- OpsCapsule gets a stable boundary for use-case-specific capabilities while
  keeping context separation in the core.
- The first extension implementation remains trusted built-in code. This is not
  third-party plugin isolation and the UI must not describe it as such.
- New integrations can reuse existing contribution and capability classes
  without application-specific manifest fields.
- A genuinely new kind of host authority still requires a reviewed core API
  change. That friction is intentional.
- The permission, lifecycle, and compatibility model can be exercised before a
  marketplace or executable extension host exists.
- Colima is the intended first built-in migration because it exercises scoped
  state, commands, target directories, networking, sockets, readiness, actions,
  and capsule lifecycle.

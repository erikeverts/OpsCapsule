# Extensions

OpsCapsule's extension contract separates target-specific capabilities from the
core isolation application. The core owns workspaces, targets, capsules,
credentials, permission grants, and sandbox policy. An extension contributes
typed functionality and requests a bounded set of capabilities.

The current slice defines and tests the contract only. It does not discover,
install, enable, or execute extensions. Only the `built-in` execution mode is
valid, and no built-in has yet been migrated to the contract.

See [ADR 0011](adr/0011-secure-extension-contract.md) for the architecture and
[the extension threat model](extension-security.md) for the security boundary.

## Manifest

Extension manifests are strict, versioned documents:

```yaml
apiVersion: opscapsule.dev/v1alpha1
kind: Extension

metadata:
  id: dev.opscapsule.example
  name: Example extension
  version: 1.0.0
  publisher: Example publisher

compatibility:
  hostApi: opscapsule.dev/extension-host/v1alpha1
  opscapsule: ">=0.5.0 <1.0.0"
  platforms:
    - darwin-arm64

execution:
  mode: built-in
```

The complete Colima-shaped example is
[`examples/extensions/colima/extension.yaml`](../examples/extensions/colima/extension.yaml).
It is illustrative and is not loaded by the application.

`metadata.publisher` is a display claim, not verification. A future installer
will record the package source, digest, signature/provenance, and approval
outside the self-declared manifest.

## Contributions

Contributions describe functionality the core knows how to present and govern:

- `settings`: a schema inside the extension bundle and its configuration scope;
- `readinessChecks`: named results aggregated into core readiness UI;
- `actions`: named operations with read, write, or destructive risk;
- `taskSources`: normalized task feeds for a workspace or target;
- `contextSources`: normalized agent-context sources; and
- `targetServices`: implementations of a separately versioned service contract.

Contribution ids are stable and unique across all contribution categories
within an extension. Permission ids use a separate extension-wide namespace.
Contributions do not grant a permission and do not provide executable UI or
Electron IPC.

## Permissions

The manifest asks for permissions in two distinct zones:

```yaml
permissions:
  host:
    privateState: [target]
    commands: []
    network: []
    targetDirectories: []
    credentials: []
  capsule:
    sockets: []
    environment: []
```

- Host permissions govern what an extension activation may ask the core to do.
- Capsule permissions govern the exact resources the core may add to a target
  capsule because of that extension.

A parsed request is not an approval. Grants are stored by the core and bound to
an exact extension version, verified manifest digest, and activation scope.

The manifest cannot contain arbitrary filesystem or socket paths, command-line
shell expressions, environment values, or credentials. Permission vocabulary is
closed: unknown fields fail validation.

## Scope and lifecycle

Extensions are installed globally but enabled explicitly. Settings and grants
may be application-, workspace-, or target-scoped. A target service normally
activates for a particular capsule session.

The lifecycle phases are:

```text
installed -> disabled -> enabled -> activating -> active
                                      |            |
                                      v            v
                                    failed <- deactivating
```

Uninstall first revokes and deactivates running resources. Failure of a required
target service may block that capsule; failure of an optional task or context
source must remain isolated to that source.

## Host API

`opscapsule.dev/extension-host/v1alpha1` initially contains only:

- an activation context bound to extension id, exact version, manifest digest,
  workspace/target/session identity, and granted permissions;
- schema-validated settings reads; and
- readiness-result reporting.

It intentionally contains no generic filesystem, process, network, credential,
socket, renderer, or Electron operation. Later slices will introduce narrowly
typed brokers while migrating a built-in extension. New authority classes
require an explicit core change and security review; arbitrary plugins do not
get to invent them.

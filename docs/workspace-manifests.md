# Workspace manifests

OpsCapsule discovers `*.yaml` and `*.yml` files in its application-data
`config/workspaces` directory. The UI shows the exact directory and source file.
Two fictional examples are created only when that directory contains no manifests.

Workspace Studio can create and edit these files from the application. The forms
and the YAML preview operate on the same public manifest model; there is no hidden
database representation. OpsCapsule validates the full manifest before saving,
writes replacements atomically, and rejects a save if another process changed the
file after it was opened.

The editor stores references to AWS profiles and kubeconfig files, never access
keys, tokens, or other credentials.

The public manifest format is versioned independently of internal TypeScript
types:

```yaml
apiVersion: opscapsule.dev/v1alpha1
kind: Workspace
```

See [`examples/workspace.yaml`](../examples/workspace.yaml) for a complete example.

## Model

- A workspace groups resources belonging to a customer, product, team, or project.
- Cloud connections describe provider-specific identities. AWS is the first
  implemented provider; an unknown provider remains parseable but cannot launch.
- Kubernetes contexts are independent resources and need not belong to a cloud
  provider.
- Directories declare read-only or read-write access.
- A target selects at most one cloud identity, at most one Kubernetes context,
  one or more directories, and one agent runtime.
- A capsule is one running instance of one target.

Multiple targets from the same workspace can run concurrently. They do not share
process environments, kubeconfigs, synthetic home directories, or temporary
directories.

## Paths

Absolute paths and paths beginning with `~/` are supported. Relative directory and
kubeconfig paths are resolved relative to the manifest file.

Every configured directory must exist before its target can launch. OpsCapsule
resolves symbolic links to canonical paths before building the sandbox policy.

## Kubernetes sources

`type: kubeconfig` extracts only the selected context, cluster, and user into a
capsule-private kubeconfig. `type: generated` exists for credential-free examples
and tests.

When a target has no Kubernetes context, OpsCapsule still sets `KUBECONFIG` to an
empty capsule-private config. This prevents accidental fallback to the user's
global context.

## Isolation

`mode: enforced` wraps every terminal process through the configured OS sandbox.
The process tree receives:

- read access to configured read-only and read-write directories;
- write access only to configured read-write directories, the capsule runtime,
  and the capsule temporary directory;
- a synthetic `HOME`; and
- no implicit access to the user's global kubeconfig or inherited AWS credentials.

`mode: context-only` is an explicit compatibility mode. It isolates environment
variables and kubeconfig state but does not enforce filesystem permissions. The UI
labels it accordingly, and OpsCapsule never silently falls back to it.

Network modes are:

- `deny`: no outbound network access;
- `allowlist`: only the listed public domains; and
- `public`: any public destination, while local services, cloud metadata endpoints,
  and Unix sockets remain blocked by the sandbox runtime.

Permission-expanding manifests belong in the trusted application-data directory,
not inside an untrusted repository. A future import flow may read repository hints,
but it must require explicit user approval before granting paths or network access.

## Current authentication limitation

Enforced capsules intentionally use a synthetic home directory. Provider and agent
credential brokering is not implemented yet, so a configured AWS profile or agent
CLI that depends on files in the real home directory may require a future broker or
an explicitly designed read grant. OpsCapsule does not expose the entire real home
directory merely to make authentication work.

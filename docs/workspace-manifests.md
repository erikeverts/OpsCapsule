# Workspace manifests

OpsCapsule discovers `config/workspaces/<id>/workspace.yaml` documents in its
application-data directory. Legacy flat `*.yaml` and `*.yml` files remain
readable and are migrated to the directory layout when saved in Workspace Studio.
The UI shows the exact directory and source file. Two fictional examples are
created only when the workspace configuration directory is empty.

Workspace Studio can create and edit these files from the application. The forms
and the YAML preview operate on the same public manifest model; there is no hidden
database representation. OpsCapsule validates the full manifest before saving,
writes replacements atomically, and rejects a save if another process changed the
file after it was opened.

The editor discovers local AWS profiles and Kubernetes contexts. Saving imports
the selected configuration under the workspace's mode-restricted `resources`
directory. AWS access-key fields are removed, and shared credentials, SSO tokens,
and caches are not imported. A selected Kubernetes user can contain authentication
material such as a token or client key, so the workspace directory is sensitive
application data and must not be committed or exported implicitly.

The public manifest format is versioned independently of internal TypeScript
types:

```yaml
apiVersion: opscapsule.dev/v1alpha1
kind: Workspace
```

See [`examples/workspace.yaml`](../examples/workspace.yaml) for a complete example.
The Iteration 4 agent-profile extension is currently a proposal; see
[`agent-profiles.md`](agent-profiles.md) and
[`ADR 0005`](adr/0005-managed-agent-profiles.md) for its exact contract and
migration plan.

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

The proposed agent-profile model moves reusable agent configuration to the
workspace and lets a target override the workspace default. Until that model is
implemented, `target.agentRuntime` remains the active manifest field.

Multiple targets from the same workspace can run concurrently. They do not share
process environments, kubeconfigs, synthetic home directories, or temporary
directories. Mutable cloud CLI state is stored under a target-specific state
directory and is not shared with another target.

## Paths

Absolute paths and paths beginning with `~/` are supported. Relative directory,
kubeconfig, and provider-config paths are resolved relative to `workspace.yaml`.

Every configured directory must exist before its target can launch. OpsCapsule
resolves symbolic links to canonical paths before building the sandbox policy.

## Kubernetes sources

Workspace Studio imports only the selected context, cluster, user, and referenced
certificate/key files. At launch, `type: kubeconfig` extracts that managed context
again into a capsule-private kubeconfig. `type: generated` exists for
credential-free examples and tests.

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

## AWS authentication

The selected AWS profile and its referenced SSO configuration are copied into the
workspace. On launch they are staged into a persistent, target-specific `.aws`
directory. AWS SSO and CLI caches can therefore survive target restarts while the
real home directory remains inaccessible.

Static shared credentials are deliberately not imported. Profiles that require
them need a future credential broker. When enforced isolation cannot open a system
browser, use the AWS CLI's no-browser/device flow for SSO login.

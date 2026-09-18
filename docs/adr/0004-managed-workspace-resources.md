# ADR 0004: Managed workspace resources and target state

- Status: Experimental
- Date: 2026-09-18

## Context

A profile name or kubeconfig path is not enough inside an enforced capsule. The
capsule cannot read the user's real home directory, and granting that access would
weaken the boundary the product is meant to provide. Kubernetes and cloud tools
also have different kinds of data: portable configuration belongs to a workspace,
while login tokens and caches are mutable state that should not be shared across
targets.

## Decision

Each new workspace owns a directory under the application-data configuration
root:

```text
config/workspaces/<workspace-id>/
  workspace.yaml
  resources/
    cloud/<connection-id>/config
    kubernetes/<context-id>/config.yaml
    kubernetes/<context-id>/assets/
```

Workspace Studio discovers AWS profiles from the standard AWS config file and
Kubernetes contexts from `KUBECONFIG` or `~/.kube/config`. On save, it imports
only the selected AWS profile and the sections it references, or only the
selected Kubernetes context, cluster, user, and referenced files. The manifest
then points at these workspace-relative copies. AWS access-key fields are removed,
and shared credentials, SSO tokens, and caches are never imported as workspace
resources.

A Kubernetes user entry can itself contain a bearer token, client key, or another
authentication mechanism. That material is required by some kubeconfigs and is
included in the private, mode-restricted managed copy. Workspace directories must
therefore be treated as sensitive application data and must never be published or
committed automatically.

Mutable provider state is target-specific:

```text
state/workspaces/<workspace-id>/targets/<target-id>/.aws/
```

At launch, the selected managed AWS config is staged there. `AWS_CONFIG_FILE`
and `AWS_SHARED_CREDENTIALS_FILE` point into that directory, and the capsule's
synthetic home exposes the same target-specific `.aws` directory. SSO and CLI
caches therefore survive capsule restarts without becoming global or crossing a
target boundary. Enforced isolation grants write access to only the active
target's state directory.

Workspace ids and ids for newly added directories, cloud connections,
Kubernetes contexts, and targets are generated from their display names. Once a
resource has been saved, its id remains stable when the display name changes.

Legacy flat `config/workspaces/*.yaml` manifests remain readable. Saving one in
Workspace Studio migrates it to the directory layout after the new directory has
been written successfully.

## Consequences

- A capsule can run `aws sso login` without reading the user's entire `~/.aws`
  directory, and its cache can be reused the next time that target opens.
- Workspace configuration is self-contained enough for future export, inspection,
  and workspace-level agent instructions.
- Development and production targets do not share mutable AWS state even when
  they reference the same host-side SSO session.
- Selecting a profile snapshots its configuration. Host-side changes are not
  picked up until the profile is selected and the workspace is saved again.
- Profiles that depend on static credentials are not made functional by copying
  `~/.aws/credentials`; a future credential broker must handle those without
  turning secrets into portable workspace files.
- Opening a browser from inside an enforced capsule may remain platform-limited;
  AWS CLI's no-browser/device flow is the compatible fallback.

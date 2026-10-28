# ADR 0009: Safe host Git configuration inheritance

- Status: Accepted
- Date: 2026-10-28
- Implementation: `src/main/git-config.ts`

## Context

Capsules use a private home directory, so Git cannot see the user's global
configuration. A commit without `user.name` and `user.email` falls back to an
identity such as `username@hostname`, which is easy to miss and difficult to
repair after pushing.

Mounting or copying the complete host configuration would solve that symptom
by weakening the boundary. Git configuration can reference credential helpers,
hooks, SSH commands, signing keys, arbitrary include files, and paths elsewhere
in the user's home directory. Conditional `includeIf` rules also mean one raw
file is not necessarily the effective configuration for every repository.

## Decision

OpsCapsule inherits an allowlisted projection by default. The main process
invokes host Git outside the sandbox and asks for only `user.name` and
`user.email`. It asks once for the global default and once in each configured
Git repository, allowing Git itself to resolve normal includes and conditional
identities without OpsCapsule reading their source files.

The values are written into a mode-0600 global config beneath the session root.
Repository-specific identities are separate mode-0600 files selected by
`includeIf gitdir` entries. `GIT_CONFIG_GLOBAL` points all three panes at the
generated file, and session cleanup removes it. Repository-local configuration
retains its normal higher precedence.

`GIT_CONFIG_NOSYSTEM` also prevents platform system configuration from
reintroducing settings outside the allowlist. On macOS, `/usr/bin/git` is an
Apple developer-tool shim that writes an `xcrun` cache outside the capsule.
OpsCapsule resolves the selected direct Git binary in the main process and
places a session-local `git` shim first on the capsule PATH. The direct binary
is granted narrow read/execute access; the host temp directory is not exposed.

The application preference defaults to enabled. A workspace manifest records
only `default`, `enabled`, or `disabled`; it never records the resolved identity.
There is no target override in the first slice because Git identity belongs to
a person, engagement, and repository rather than a deployment environment.
Per-repository host rules already represent the common personal/work split.

Readiness shows the effective identities. Missing Git or an incomplete identity
is a warning rather than a launch blocker, while an explicit opt-out is a valid
passing state.

## Security boundary

OpsCapsule does not copy or expose the host Git file. It discards inherited
`GIT_*` overrides while inspecting the host and never materializes credential
helpers, hooks, signing configuration, SSH commands, include paths, or any
unrecognised key. Agent profiles cannot replace the generated Git config
environment variables.

SSH and GPG remain separate credential-broker capabilities. This decision does
not grant a capsule access to private keys, agents, or signing authority.

## Consequences

- Normal commits receive the intended identity without exposing the user's
  home directory.
- Work and personal identities selected with `includeIf` can differ across the
  configured repositories in one target.
- Changes to host identity take effect on the next readiness check and capsule
  launch, not during an already running session.
- Other useful Git settings may be considered individually later; none become
  implicitly trusted because identity inheritance exists.

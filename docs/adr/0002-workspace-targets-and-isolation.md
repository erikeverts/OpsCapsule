# ADR 0002: Workspace targets and enforced process isolation

- Status: Experimental
- Date: 2026-09-17

## Context

A customer or project can have several cloud accounts, Kubernetes contexts, and
local repositories. Putting all of them into one shell would recreate the context
switching risk OpsCapsule is intended to reduce. Agent processes also run with the
user's host permissions unless an operating-system boundary is applied.

## Decision

OpsCapsule distinguishes persistent workspaces, configured resources, named
targets, and running capsules. A target selects no more than one active cloud
identity and one active Kubernetes context. Users compare or operate on multiple
targets by launching separate capsules.

Cloud configuration uses a provider-neutral envelope with provider-owned config.
AWS is the first adapter. Kubernetes remains independent of cloud providers.

Every capsule receives a synthetic home, a dedicated temporary directory, and an
extracted single-context kubeconfig. All three PTYs use the same isolation policy.

Enforced isolation is implemented behind an OpsCapsule interface using the pinned
Anthropic Sandbox Runtime research preview. It wraps arbitrary commands and is not
an agent integration. It currently uses macOS Seatbelt and Linux Bubblewrap. On
Windows, capsule processes run inside WSL 2 and use the Linux backend; see
[ADR 0006](0006-windows-wsl-execution-host.md).

The application fails closed when enforced isolation is unavailable. Context-only
execution is possible only when explicitly selected in trusted configuration.

## Consequences

- Multiple accounts and clusters can belong to one workspace without becoming
  simultaneously active in one capsule.
- Runtime and isolation adapters remain orthogonal and replaceable.
- Project folders can be read-only or read-write at the OS boundary.
- User-installed tools and authentication that depend on the real home directory
  need explicit mediation rather than implicit access.
- The beta sandbox dependency must be pinned, monitored, and covered by integration
  tests. A container backend remains a future alternative.


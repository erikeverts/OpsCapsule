# ADR 0010: Target-owned container runtimes

- Status: Accepted
- Date: 2026-11-05
- Implementation: `src/main/container-runtimes/colima.ts`

## Context

Operations work commonly needs `docker build`, Compose, and disposable local
services. The enforced capsule currently denies `/var/run/docker.sock`, which is
intentional: access to a shared Docker daemon is effectively host-level
authority. A process with that socket can start a privileged container or bind
mount host paths the capsule itself cannot read.

Giving the capsule Docker Desktop's user socket would have the same problem. A
socket allowlist makes the connection narrow by pathname, but it cannot reduce
the authority offered by the daemon behind that pathname.

## Decision

A target may opt in to an `isolated` container runtime. The first provider is
Colima on macOS. OpsCapsule creates a separate Colima profile and persistent VM
state for each workspace target. It starts the VM before the terminal worker and
stops it when the capsule stops; images, containers, and volumes remain on disk
until the user explicitly resets that target's Docker environment.

The VM receives only the directories selected by the target. Read-only and
read-write declarations are preserved in the Colima mounts. The user's home,
SSH agent, SSH configuration, Docker Desktop socket, and host Docker context are
not mounted or activated. Automatic host-port forwarding is disabled so a
container cannot silently publish a service outside the capsule. `DOCKER_HOST`
points the capsule at the target VM's
exact Unix socket, `DOCKER_CONFIG` points at target-private client state, and the
sandbox continues to reject every other Unix socket.

Colima state is application-managed and remains outside the capsule filesystem
allowlist. A stable short alias under `/private/tmp` keeps the socket below the
macOS Unix-domain path limit without relocating the persistent VM data.

The manifest contract is provider-neutral at the target boundary even though
the current provider enum contains only `colima`:

```yaml
containerRuntime:
  mode: isolated
  provider: colima
  persistence: target
  resources:
    cpus: 4
    memoryGiB: 8
    diskGiB: 60
```

An isolated runtime requires enforced filesystem isolation and, in this slice,
`public` network mode. Container traffic leaves through the VM and does not pass
through the process-level Sandbox Runtime network filter. Deny and domain
allowlist policies are therefore rejected rather than silently weakened.

## Security boundary

This decision isolates host filesystem authority, not container networking.
Containers can reach only host paths mounted into their target VM, but they have
the VM's normal outbound network access. Readiness and Workspace Studio both
state this limitation.

The feature never falls back to a shared daemon. Missing Colima or Docker CLI
prerequisites block launch. Host registry credentials are not copied; logins made
through the capsule are stored in target-private Docker client state.

## Consequences

- Docker and Compose workloads can run without granting access to the host
  daemon or unrelated workspace directories.
- Each target pays the CPU, memory, disk, download, and startup cost of its own
  VM.
- VM startup adds latency to capsule launch, although subsequent starts reuse
  the existing VM and container data.
- Paths containing spaces and overlapping mounts are rejected because Colima
  cannot mount them safely in this configuration.
- Linux, Windows/WSL, container-network filtering, registry credential
  brokering, and alternative providers remain later adapters, not implicit
  behavior in the Colima implementation.

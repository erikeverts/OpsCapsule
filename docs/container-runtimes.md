# Isolated containers

OpsCapsule can give a target its own Docker engine without exposing Docker
Desktop or `/var/run/docker.sock`. The first implementation uses a target-owned
[Colima](https://github.com/abiosoft/colima) VM on macOS.

## Prerequisites

Install Colima and the Docker CLI on the host:

```sh
brew install colima docker
```

The readiness report checks both commands before launch. OpsCapsule starts and
stops Colima itself; do not start the generated profile manually or make it the
active host Docker context.

## Configuration

Enable **Isolated Docker** on a target in Workspace Studio, or add:

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

The target must use `isolation.mode: enforced` and public network mode. Every
configured directory is mounted into the VM at the same absolute path and with
the declared read-only or read-write access. Colima cannot accept a path with a
space, colon, or comma, or overlapping parent and child mounts; readiness reports those
as launch blockers.

Inside the capsule, ordinary commands use the isolated engine:

```sh
docker version
docker compose up
```

`DOCKER_HOST` names only that target's socket. `DOCKER_CONFIG` is target-private,
so registry logins are not inherited from the host and are not shared with
another target.

## Lifecycle and reset

Launching a capsule starts its VM. **Stop capsule** stops the VM but retains its
images, containers, volumes, and Docker client state. **Reset Docker
environment** deletes all of those for the selected target and recreates an
empty client state directory. It is intentionally a confirmed destructive
action and is unavailable while the capsule is running.

The VM's persistent provider state is stored under the short, application-owned
`~/.opscapsule/cr/` tree. This location is outside the capsule filesystem grant
and keeps Colima and Lima Unix sockets below macOS's path-length limit.

Workspace deletion never treats container data as incidental state. If a target
has created a VM, OpsCapsule asks you to reset that Docker environment first;
deleting the workspace cannot silently remove images or volumes.

## Boundary and current limitation

The VM receives only the target's configured directories. It does not receive
the user's home, SSH agent, or host Docker socket. This prevents a container
from using a bind mount to escape into an unconfigured host directory.

Container networking is a separate boundary. Traffic from containers leaves
through the VM and is not filtered by OpsCapsule's process network allowlist.
For that reason this iteration supports only public network mode; it does not
pretend that deny or allowlist policies cover container workloads.

Automatic Colima host-port forwarding is disabled. A published container port
is therefore not silently opened on the host and cannot yet be reached from a
capsule through `localhost`. Tests can run inside the container or on a shared
container network; narrowly brokered port access is future work.

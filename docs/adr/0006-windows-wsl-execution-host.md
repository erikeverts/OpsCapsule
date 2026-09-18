# ADR 0006: Windows support through a WSL execution host

- Status: Experimental
- Date: 2026-09-18

## Context

OpsCapsule enforces filesystem and network policy with the pinned Anthropic
Sandbox Runtime. Its Windows backend is alpha and runs the sandboxed command as a
separate local user (`srt-sandbox`), which conflicts with the capsule model of a
synthetic `HOME`, capsule-private kubeconfig, and injected cloud environment
owned by the operator. It also needs an elevated machine-wide install and cannot
reach per-user tool installations.

WSL 2 is present on most Windows workstations used for cloud operations, and the
Linux Bubblewrap backend already works there. The tools that run inside a capsule
(`kubectl`, `aws`, `helm`, agent CLIs) are Linux-native.

## Decision

On Windows the Electron application runs natively and acts as a broker. Every
capsule process executes inside a WSL 2 distribution. This is modelled by an
`ExecutionHost` interface with two implementations:

- `local` (macOS, Linux): unchanged behaviour; processes and runtime files live
  on the Electron host.
- `wsl` (Windows): runtime files, isolation preparation, and process execution
  happen inside the distribution.

The Linux-side work is performed by `dist/wsl-helper.cjs`, a Node.js program
that runs inside the distribution and reuses the same runtime-directory and
isolation code as the Linux host. The Windows side invokes it with
`wsl.exe --exec` through the user's login shell, passing one JSON request on
stdin and reading one marked JSON result line. The helper falls back to an
interactive login shell only when Node.js is not found otherwise, because common
distribution rc files configure version managers for interactive shells only.

Terminals are spawned as
`wsl.exe [--distribution X] --cd <cwd> --exec /usr/bin/env -i KEY=VALUE... <command>`
under a ConPTY created by `node-pty`. The capsule environment is passed
explicitly, so neither the Windows process environment nor the WSL login session
leaks into a capsule implicitly.

Runtime state lives at `${XDG_STATE_HOME:-~/.local/state}/opscapsule` inside the
distribution so POSIX permission bits and ownership checks work. Workspace
manifests remain in the Windows application-data directory; paths inside them
are interpreted with POSIX semantics, `~` is the WSL home, and manifest-relative
paths resolve against the manifest directory as mounted inside WSL.

`WSL_INTEROP` is removed from the environment of every enforced capsule. Interop
lets a Linux process ask the WSL service to launch a Windows executable outside
any Linux sandbox; the Bubblewrap policy already denies `/mnt`, and dropping the
variable removes the remaining entry point.

The application fails closed at startup when WSL or Node.js inside WSL is
unavailable. Native Windows execution of capsule processes is not offered.

## Consequences

- Enforced isolation on Windows uses the same tested Linux backend, not the
  alpha Windows backend.
- Windows users need a WSL 2 distribution with Node.js and, for enforced
  targets, `bwrap`, `socat`, and `rg`.
- Session start incurs a few `wsl.exe` round trips (path translation, probe,
  runtime creation, isolation preparation).
- The capsule environment is carried on the `wsl.exe` command line, which is
  limited to 32767 characters. Very large inherited environments can exceed it;
  moving the environment into a runtime file is the planned mitigation.
- Windows drives are visible at `/mnt/<drive>` inside WSL and are denied by the
  enforced policy unless a configured directory re-allows a subtree.
- Distributions with `interop` enabled can still run Windows executables from
  context-only capsules; that mode remains an explicit compatibility choice.
- Managed devices without virtualization cannot run OpsCapsule.
- Bubblewrap requires unprivileged user namespaces; some distributions need
  `kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile.

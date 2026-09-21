# ADR 0007: Windows support through a WSL execution host

- Status: Experimental
- Date: 2026-09-21 (supersedes the 2026-09-18 draft)

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

[ADR 0006](0006-terminal-utility-process.md) moved every `node-pty` instance and
the Sandbox Runtime session into one application-owned terminal worker per
capsule. Electron's embedded Node.js is a Windows binary, so that worker cannot
run inside WSL as an Electron utility process.

## Decision

On Windows the Electron application runs natively and acts as a broker. Every
capsule process executes inside a WSL 2 distribution. This is modelled by an
`ExecutionHost` interface with two implementations:

- `local` (macOS, Linux): unchanged behaviour; processes and runtime files live
  on the Electron host and the terminal worker is an Electron utility process.
- `wsl` (Windows): runtime files, isolation preparation, readiness checks, and
  process execution happen inside the distribution.

Two Linux-side programs run under the distribution's Node.js:

- `dist/wsl-helper.cjs` handles one-shot requests (probe, runtime creation and
  cleanup, isolation preparation, readiness, directory inspection). It reuses
  the same runtime-directory and isolation code as the Linux host. The Windows
  side invokes it with `wsl.exe --exec` through the user's login shell, passing
  one JSON request on stdin and reading one marked JSON result line.
- `dist/terminal-worker.cjs` is the same terminal worker module Electron forks on
  macOS and Linux. Inside WSL it is started with `--stdio` and exchanges the
  worker protocol as JSON lines over the `wsl.exe` pipe instead of a
  `MessagePort`; responses carry a marker so login-shell output on stdout is
  ignored. The worker owns the Linux `node-pty` instances, initialises Sandbox
  Runtime once per capsule, and resolves and probes the agent executable on the
  filesystem where the capsule runs. Losing the pipe shuts the worker and its
  terminals down.

Both programs are started through a login shell so Node.js installed via
profile-managed `PATH` entries is found; an interactive login shell is used only
when Node.js is not found otherwise, because common distribution rc files
configure version managers for interactive shells only.

Runtime state lives at `${XDG_STATE_HOME:-~/.local/state}/opscapsule` inside the
distribution so POSIX permission bits and ownership checks work. Workspace
manifests remain in the Windows application-data directory; paths inside them
are interpreted with POSIX semantics, `~` is the WSL home, and manifest-relative
paths resolve against the manifest directory as mounted inside WSL.

Capsule processes receive only the explicit capsule environment built by the
runtime-directory code; `WSL_INTEROP` is never part of it. Interop lets a Linux
process ask the WSL service to launch a Windows executable outside any Linux
sandbox; the Bubblewrap policy already denies `/mnt`, and omitting the variable
removes the remaining entry point.

The application fails closed at startup when WSL or Node.js inside WSL is
unavailable. Native Windows execution of capsule processes is not offered.

## Consequences

- Enforced isolation on Windows uses the same tested Linux backend, not the
  alpha Windows backend, and the same per-capsule worker model as other hosts.
- Windows users need a WSL 2 distribution with Node.js and, for enforced
  targets, `bwrap`, `socat`, and `rg`. This is a deliberate exception to
  ADR 0006's goal of not depending on a user-installed Node.js: there is no
  application-owned Linux runtime yet. Packaging should ship a pinned Linux
  Node.js runtime and a `linux-x64` `node-pty` prebuild for the WSL side.
- `node-pty` must be built for Linux inside the distribution for development
  checkouts (`npm rebuild node-pty` inside WSL); it is N-API based, so one
  prebuild serves the supported Node.js versions.
- Session start incurs a few `wsl.exe` round trips (path translation, probe,
  runtime creation, isolation preparation) plus one long-lived `wsl.exe` per
  capsule for the worker pipe.
- Terminal traffic and the per-terminal environment travel through the worker
  pipe, so nothing is subject to the Windows command-line length limit and no
  ConPTY sits between the renderer and the Linux pseudo-terminal.
- Windows drives are visible at `/mnt/<drive>` inside WSL and are denied by the
  enforced policy unless a configured directory re-allows a subtree. Sandbox
  Runtime's own `apply-seccomp` helper is re-exposed read-only from the
  application's `node_modules`, so a capsule sees only that skeleton path (for
  example `/mnt/c/src/OpsCapsule/node_modules/...`) and nothing else on the
  drive. The same applies to development checkouts under `/home` on Linux.
- `npm run verify:wsl-host` (Windows, needs a WSL distribution prepared as
  above) runs the production host, helper, worker, and an enforced capsule
  without Electron and checks isolation from inside the capsule.
- Studio discovery of `~/.aws` and `~/.kube` still reads the Windows-side home;
  importing them from the WSL home is planned as a follow-up.
- Managed devices without virtualization cannot run OpsCapsule.
- Bubblewrap requires unprivileged user namespaces; some distributions need
  `kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile.

# ADR 0008: Windows support through WSL rather than a native port

- Status: Proposed
- Date: 2026-09-30

## Context

OpsCapsule enforces isolation with the operating system: `sandbox-exec` on
macOS, and `bwrap` with `socat` on Linux. The sandbox runtime it uses ships
implementations for those two platforms and nothing else, and OpsCapsule itself
refuses Windows explicitly rather than pretending:

> Enforced isolation is not enabled on Windows in this iteration; use
> context-only mode explicitly

There is no equivalent primitive to port to. Windows has job objects, AppContainer
and Sandbox, but none of them is a drop-in for a profile that grants specific
filesystem roots and a network policy to a process tree, and building one would
be a security project in its own right rather than a port.

Meanwhile the isolation guarantee is the product. A Windows build with
context-only isolation would carry the name without the property, which is
worse than not shipping on Windows at all: the one thing a user must be able to
trust is that a capsule is contained.

WSL2 provides a real Linux kernel on Windows, and the Linux implementation
already exists and is tested.

## Decision

**Windows is supported by running the Linux build under WSL2 with WSLg.**
There is no native Windows build, and no split where the interface runs on
Windows while capsules run in WSL.

WSLg renders Linux GUI applications as ordinary Windows windows, so the Linux
Electron package runs unchanged and appears as a normal application. Everything
below it is genuinely Linux: `bwrap` enforcement, unix domain sockets, file
permissions, the credential broker, and the paths a capsule sees.

Windows support therefore becomes a property of Linux support rather than a
third platform to maintain.

### Why not run the interface on Windows and capsules in WSL

This is the arrangement an earlier pull request attempted, and it splits the
application across the boundary it exists to enforce:

- The credential broker listens on a **unix domain socket**. The helper would
  run inside WSL while the broker ran on Windows, and WSL2 offers no general
  AF_UNIX interop, so the transport would have to be replaced with something
  that crosses the boundary — precisely the surface that should not exist.
- Every path would need translating, in both directions, for workspace
  directories, kubeconfigs, managed resources and agent configuration.
- Windows drives mounted at `/mnt` present flat permissions, so the `0600` and
  `0700` guarantees the credential and context surfaces rely on would not hold.

Each seam is a place where a guarantee is asserted on one side and not honoured
on the other. The cost is not the work; it is that the result would be harder to
reason about than either platform alone.

### Why not a headless service with a browser interface

Running the application headless inside WSL and serving an interface to a
Windows browser is appealing, because everything below the interface becomes
Linux and works as designed. It is rejected for two reasons.

The first is mechanical. OpsCapsule depends on Electron beyond the window:
`utilityProcess` hosts the terminal worker, chosen deliberately in
[ADR 0006](0006-terminal-utility-process.md) so that terminals run on the
application's own runtime with `RunAsNode` disabled, and `safeStorage` is the
entire basis of the credential store. A headless Node service would have to
replace both.

The second is the trust model, and it is the deciding one. OpsCapsule currently
has **no network surface**: an isolated renderer, a preload bridge, and a custom
protocol. A browser interface means an HTTP and WebSocket server that can launch
capsules and mint credentials, reachable by any process on the machine that can
open a socket. Authentication, origin checks and CSRF protection would all
become load-bearing for a product whose claim is containment. Trading a local
IPC boundary for a network one is a poor trade when the alternative already
works.

## Consequences

- Windows requires Windows 11, or Windows 10 with WSLg, plus WSL2 and the same
  host dependencies Linux needs: `bwrap`, `socat`, `rg`, `curl`, and a keyring.
- Linux packaging, already outstanding, becomes the gate for Windows support.
  One artefact serves both.
- Workspace directories should live in the WSL filesystem. Working across
  `/mnt/c` is slow and does not carry the permissions the product relies on,
  and this needs saying plainly in the documentation rather than being
  discovered.
- A keyring must be installed and unlocked inside WSL, which a default
  installation does not have. Without one the credential store refuses to
  store anything, by design.
- Electron under WSLg was the main technical risk in this decision. It has
  since been confirmed to start without flags on a tester's machine, so the
  risk is retired. Chromium reports that it cannot reach the system D-Bus,
  which WSL does not run; nothing OpsCapsule depends on uses that bus.
- The session bus is a different matter. The keyring is reached over it, so
  OpsCapsule has to run inside a session that also runs the keyring, and the
  credential store distinguishes a missing session from a missing keyring
  because they need different fixes.
- Windows users who will not run WSL are not served. That is accepted: a build
  without enforced isolation would carry the product's name without its
  property.
- The earlier Windows execution-host work is superseded and should be closed
  rather than rebased, since it predates the utility process, the managed agent
  profiles and the credential broker, and its central mechanism is the one this
  decision rejects.

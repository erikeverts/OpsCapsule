# ADR 0006: Terminal utility process and embedded Node runtime

- Status: Experimental
- Date: 2026-09-21

## Context

The first isolation implementation launched a JavaScript sandbox runner through
the first `node` executable found on the user's `PATH`. That made enforced
isolation depend on an undeclared host runtime with an uncontrolled version.

Electron can expose its executable as a general-purpose Node.js runtime through
`ELECTRON_RUN_AS_NODE`. Keeping that capability enabled would weaken the
packaged application's security posture: other local processes could repurpose
the signed OpsCapsule executable to run arbitrary Node.js scripts with the
application's identity and permissions.

The terminal process must remain attached to a real pseudo-terminal so that
interactive shells and agent TUIs retain job control, signals, resizing, and
full-screen rendering.

## Decision

OpsCapsule does not use `ELECTRON_RUN_AS_NODE` and will disable the `RunAsNode`
fuse when packaging is introduced.

Each running capsule receives a fixed, packaged Electron utility-process worker.
The worker owns the capsule's `node-pty` instances and communicates with the main
process through typed messages for input, output, resize, lifecycle, and errors.
The renderer continues to communicate only through the existing validated preload
API and cannot select a worker module or launch an arbitrary utility process.

For enforced targets, the worker initializes Anthropic Sandbox Runtime once for
the capsule and asks it for the wrapped command and environment for each terminal.
For context-only targets, the same worker launches the requested command directly.
The agent executable is still resolved in the main process and probed from inside
the sandbox before its interactive terminal starts.

The worker path is application-owned. User-selected agent commands remain child
processes inside the configured capsule boundary; Electron's embedded Node.js is
not placed on their `PATH`.

## Consequences

- A release no longer depends on a user-installed Node.js runtime for its own
  sandbox implementation.
- OpsCapsule can disable `RunAsNode`, `NODE_OPTIONS`, and Node inspector fuses.
- All terminal traffic crosses one additional typed process boundary.
- A worker crash affects one capsule instead of the Electron main process.
- `node-pty` must be rebuilt for Electron and included as a signed, unpacked native
  module in packaged applications.
- Sandbox Runtime and the terminal worker must be included in packaged resources
  and tested from the signed artifact.
- Packaging still needs an explicit fuse configuration, ASAR integrity settings,
  signing, notarization, and release automation.

## Validation

`npm run verify:terminal-worker` builds the worker and launches a real Electron
utility process that starts a PTY, captures output, observes its exit, and shuts
down cleanly. Filesystem-enforcement integration tests continue to exercise the
same Sandbox Runtime command wrapping used by the worker when the host permits
nested sandboxing.

# OpsCapsule

An isolated workspace for cloud operations and agent-assisted work.

OpsCapsule is an early open-source experiment for running multiple customer or
project contexts side by side without sharing mutable AWS or Kubernetes state. It
is designed to be agent-agnostic and LLM-agnostic: an agent is a runtime launched
inside a capsule, not a framework embedded into the application.

## Architecture spike

The current spike provides:

- two concurrent demo capsules with distinct AWS profiles and kubeconfig files;
- three PTY-backed terminals per capsule: one agent runtime and two shells;
- a generic command runtime adapter for any interactive agent CLI;
- a sandboxed Electron renderer with a narrow, validated preload API; and
- automated checks for workspace isolation and IPC input validation.

The included kubeconfigs contain no credentials and use `.invalid` endpoints. This
is a technical spike, not yet a hardened boundary for production credentials or
untrusted configuration.

## Development

Prerequisites are a recent Node.js release, npm, and the platform build tools
needed by `node-pty`.

```sh
npm install
npm run dev
```

Useful checks:

```sh
npm test
npm run typecheck
npm run build
```

See [the spike notes](docs/spike.md) and
[ADR 0001](docs/adr/0001-electron-typescript-spike.md) for scope, decisions, and
open questions.

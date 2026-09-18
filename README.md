# OpsCapsule

An isolated workspace for cloud operations and agent-assisted work.

OpsCapsule is an early open-source experiment for running multiple customer or
project contexts side by side without sharing mutable AWS or Kubernetes state. It
is designed to be agent-agnostic and LLM-agnostic: an agent is a runtime launched
inside a capsule, not a framework embedded into the application.

## Iteration 4

The current iteration provides:

- a Workspace Studio for creating and editing manifests without hand-writing
  YAML;
- reusable workspace-level agent profiles with a workspace default and optional
  target overrides;
- managed OpenCode and Claude Code settings imports, plus a generic
  custom-command adapter;
- portable workspace instructions translated to `AGENTS.md`, `CLAUDE.md`, or
  an explicit environment path by the selected adapter;
- structured warnings for imported identity overrides, credentials, hooks,
  plugins, and MCP declarations;
- a visible, non-mutating readiness report for agent, filesystem, and sandbox
  prerequisites before launch;
- persistent agent data, cache, and session state isolated by workspace, target,
  and profile;
- agent executable and sandbox-reachability checks before terminals start;
- form-based management of directories, AWS connections, Kubernetes contexts,
  agent profiles, targets, and isolation policies;
- generated stable ids for workspaces and their resources, plus version-control
  indicators for configured directories;
- discovery and workspace-scoped import of local AWS profiles and Kubernetes
  contexts, while excluding AWS access keys and login caches;
- per-workspace configuration directories and persistent, target-specific cloud
  CLI state;
- live validation and a generated YAML preview;
- revision-aware, atomic manifest saves that refuse to overwrite external edits;
- versioned YAML workspace manifests;
- multiple cloud connections, Kubernetes contexts, directories, and named targets
  per workspace;
- an AWS provider adapter behind a cloud-provider-neutral interface;
- concurrent target capsules with distinct environments, synthetic homes,
  temporary directories, and single-context kubeconfigs;
- OS-enforced filesystem and network policies for every terminal process;
- three PTY-backed terminals per capsule: one agent runtime and two shells;
- a generic command runtime adapter for any interactive agent CLI;
- a sandboxed Electron renderer with a narrow, validated preload API; and
- automated checks for workspace isolation and IPC input validation.

The included examples contain no credentials and use `.invalid` endpoints.
Provider and agent credential brokering, workspace metadata and reference
documents, identity preflight, packaging, and a full security review are still
required before production use.

## Development

Prerequisites are a recent Node.js release, npm, and the platform build tools
needed by `node-pty`.

Enforced isolation additionally requires:

- macOS: `rg` (ripgrep); or
- Linux: `bwrap`, `socat`, and `rg`.

Windows can parse the same manifests but currently requires explicit
`context-only` mode while its isolation backend is evaluated.

```sh
npm install
npm run dev
```

On macOS, the development command runs inside the dependency's `Electron.app`
bundle. The Dock icon is replaced at runtime, but Stage Manager and some window
previews may still show Electron's bundle icon. A packaged `OpsCapsule.app` will
use the supplied `assets/icons/macos/OpsCapsule.icns` throughout.

Useful checks:

```sh
npm test
npm run typecheck
npm run build
```

See [workspace manifests](docs/workspace-manifests.md),
[ADR 0001](docs/adr/0001-electron-typescript-spike.md),
[ADR 0002](docs/adr/0002-workspace-targets-and-isolation.md),
[ADR 0003](docs/adr/0003-workspace-studio.md), and
[ADR 0004](docs/adr/0004-managed-workspace-resources.md) for current
configuration and decisions. The Iteration 4 agent-profile contract is described in
[agent profiles](docs/agent-profiles.md) and
[ADR 0005](docs/adr/0005-managed-agent-profiles.md).

# OpsCapsule

An isolated workspace for cloud operations and agent-assisted work.

OpsCapsule is an early open-source experiment for running multiple customer or
project contexts side by side without sharing mutable AWS or Kubernetes state. It
is designed to be agent-agnostic and LLM-agnostic: an agent is a runtime launched
inside a capsule, not a framework embedded into the application.

## Iteration 3

The current iteration provides:

- a Workspace Studio for creating and editing manifests without hand-writing
  YAML;
- form-based management of directories, AWS connections, Kubernetes contexts,
  targets, agent commands, and isolation policies;
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
Provider and agent credential brokering, identity preflight, packaging, and a full
security review are still required before production use.

## Development

Prerequisites are a recent Node.js release, npm, and the platform build tools
needed by `node-pty`.

Enforced isolation additionally requires:

- macOS: `rg` (ripgrep); or
- Linux: `bwrap`, `socat`, and `rg`.

### Windows

On Windows the Electron application runs natively while every capsule process
runs inside a WSL 2 distribution. Runtime files (synthetic homes, kubeconfigs,
sandbox policies) live in the distribution under `~/.local/state/opscapsule`,
and enforced isolation uses the Linux Bubblewrap backend inside WSL.

Requirements inside the distribution:

- Node.js on the login-shell `PATH` (for example `apt install nodejs`, or a
  version manager configured in `~/.profile`, `~/.zprofile`, or `~/.bashrc`);
- for enforced isolation: `bwrap`, `socat`, and `rg`.

The default distribution is used unless `OPSCAPSULE_WSL_DISTRO` names another.
Workspace manifests stay in the Windows application-data directory, but the
paths inside them are Linux paths as seen from the distribution (for example
`~/projects/app` or `/mnt/c/Users/Ada/projects/app`). See
[ADR 0006](docs/adr/0006-windows-wsl-execution-host.md) for details and limits.

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

See [workspace manifests](docs/workspace-manifests.md),
[ADR 0001](docs/adr/0001-electron-typescript-spike.md),
[ADR 0002](docs/adr/0002-workspace-targets-and-isolation.md),
[ADR 0003](docs/adr/0003-workspace-studio.md),
[ADR 0004](docs/adr/0004-managed-workspace-resources.md), and
[ADR 0006](docs/adr/0006-windows-wsl-execution-host.md) for configuration,
decisions, and open questions.

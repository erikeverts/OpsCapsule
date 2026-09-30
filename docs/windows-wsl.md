# Running OpsCapsule on Windows

OpsCapsule runs on Windows as the Linux build under WSL2 with WSLg, which
renders it as an ordinary Windows window. There is no native Windows build, and
the reasoning is in
[ADR 0008](adr/0008-windows-through-wsl.md): enforced isolation depends on
Linux and macOS primitives that Windows has no equivalent of, and a build
without that isolation would carry the product's name without its property.

## What you need

| Requirement | Why |
| --- | --- |
| Windows 11, or Windows 10 with WSLg | Runs the interface as a Windows window |
| WSL2 with a distribution | Provides the Linux kernel the isolation uses |
| `bubblewrap`, `socat`, `ripgrep`, `curl` | Enforced isolation and the credential broker |
| A keyring, such as `gnome-keyring` | Credential storage refuses to run without one |

On Debian or Ubuntu under WSL:

```bash
sudo apt-get update
sudo apt-get install -y bubblewrap socat ripgrep curl gnome-keyring
```

## The keyring is not optional

A default WSL installation has no keyring. Without one, Electron falls back to
a backend that encrypts with a hardcoded key, which is obfuscation rather than
encryption, and OpsCapsule refuses to store credentials at all rather than
store them unprotected.

The keyring also has to be unlocked in the session:

```bash
# Starts a session daemon and unlocks the login keyring.
dbus-run-session -- gnome-keyring-daemon --unlock
```

If credentials cannot be stored, the Credentials pane says so and names this as
the cause.

## Running it

Download the Linux artifact from the Release workflow, unpack it inside the WSL
filesystem, and run the binary. A zip is used rather than a package so nothing
needs root.

```bash
unzip opscapsule-linux-x64.zip -d ~/opscapsule
~/opscapsule/OpsCapsule
```

## Keep workspaces inside WSL

Put workspace directories in the Linux filesystem, under `~`, not on a Windows
drive under `/mnt/c`.

Windows drives are slow to traverse from WSL, and they present flat
permissions, so the `0600` and `0700` modes the credential and context surfaces
rely on are not honoured. A capsule reading its context from `/mnt/c` is not
protected the way the same capsule is on a Linux path.

## What is unverified

Two things in this path have not been proven, and both are called out in
ADR 0008 rather than assumed:

- **Electron under WSLg.** It may need specific flags, particularly around GPU
  and sandboxing. This is the main technical risk.
- **Enforced isolation on Linux.** The implementation exists and the host
  dependencies are checked before launch, but the sandbox acceptance tests only
  execute on macOS, so the Linux path has no automated coverage. Treat a first
  run as a test of that, and check the readiness report before trusting a
  capsule with anything that matters.

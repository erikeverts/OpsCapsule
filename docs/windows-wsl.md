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

Everything else is declared by the package, including `bubblewrap` and `socat`
for enforced isolation, `ripgrep` and `curl` for the sandbox preflight and the
credential broker, and a keyring. Installing it is enough to launch a capsule,
not merely enough to open the window:

```bash
sudo apt-get update
sudo apt install ./opscapsule_*_amd64.deb   # or _arm64.deb
```

## The keyring is not optional

A default WSL installation has no keyring, and no D-Bus session for one to be
reached over. Without them Electron falls back to a backend that encrypts with
a hardcoded key, which is obfuscation rather than encryption, so OpsCapsule
refuses to store credentials at all rather than store them unprotected.

The keyring is reached over the **session bus**, which means OpsCapsule and the
keyring have to run inside the same session. Starting OpsCapsule arranges this
itself, so there is nothing extra to type:

```bash
opscapsule
```

When a desktop session already provides a bus, as on an ordinary Linux desktop,
the launcher changes nothing and hands straight over. When there is none, as on
WSL, it creates one and starts a secret service inside it before launching.

The first run creates a login keyring and may ask for a password.

If credentials cannot be stored, the Credentials pane says which of the two is
missing, the session or the keyring, since they need different fixes.

## Console messages that are expected

WSL runs no system D-Bus daemon, so Chromium reports that it cannot reach it:

```
ERROR:dbus/bus.cc:406] Failed to connect to the bus:
  Failed to connect to socket /run/dbus/system_bus_socket
ERROR:dbus/object_proxy.cc:572] Failed to call method:
  org.freedesktop.DBus.NameHasOwner
```

These concern the **system** bus, which Chromium uses for desktop integrations
such as power management and notifications. Nothing OpsCapsule depends on uses
it, and the messages are noise.

Messages about the **session** bus are different: that is the one the keyring
needs, and the command above provides it.

## Running it

Each build produces two artifacts. Take the one matching your architecture:

```bash
uname -m   # x86_64 takes x64, aarch64 takes arm64
```

### Install the package

Use the `.deb` unless you have reason not to:

```bash
sudo apt install ./opscapsule_*_amd64.deb   # or _arm64.deb
opscapsule
```

The artifact contains both forms: `deb/` holds the package and `zip/` the
archive.

Electron links against a set of system libraries that a default WSL
installation does not have, and the first missing one appears as
`error while loading shared libraries: libnspr4.so`. The package declares them,
so `apt` resolves them. Installing also puts `chrome-sandbox` in place with the
ownership Electron expects.

### Or run the archive

The zip is the same application without an install step, which means both of
those problems are yours to solve:

```bash
sudo apt-get install -y libgtk-3-0 libnotify4 libnss3 libnspr4 libxtst6 \
  libatspi2.0-0 libdrm2 libgbm1 libxkbcommon0 libsecret-1-0 xdg-utils \
  libasound2t64 || sudo apt-get install -y libasound2

unzip OpsCapsule-linux-*.zip -d ~/opscapsule
cd ~/opscapsule/OpsCapsule-linux-*

# A zip cannot carry root ownership or the setuid bit, which Electron's
# sandbox helper requires, so grant them before the first run.
sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox

# The launcher arranges a session and keyring when the host has none.
# ./OpsCapsule starts the application directly and skips that.
./opscapsule-launcher
```

Starting with `--no-sandbox` avoids that last step and is the wrong way round.
It disables Chromium's own process sandbox, which protects the interface from
the content it renders. It does not affect capsule isolation, which bubblewrap
enforces separately, but it weakens the application and should not become the
habit.

An unpacked Electron application is a directory rather than one file: a binary,
a sandbox helper, resource archives, locales and the application bundle. macOS
hides the same contents inside a `.app`, which is why it looks like a single
item there.

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

#!/bin/sh
# Launcher for OpsCapsule on Linux.
#
# The credential store needs a keyring, and a keyring is reached over the D-Bus
# session bus. A desktop session provides both, so there this script does
# nothing but hand over to the application.
#
# WSL provides neither. Rather than asking someone to assemble a session on the
# command line every time they start the application, this creates one when
# there is none and starts a secret service inside it.
set -eu

here="$(dirname "$(readlink -f "$0")")"
binary="${here}/OpsCapsule"

# A session already exists, so the desktop is managing it. Change nothing.
if [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] || [ -n "${OPSCAPSULE_SESSION:-}" ]; then
  if [ -n "${OPSCAPSULE_SESSION:-}" ] && command -v gnome-keyring-daemon >/dev/null 2>&1; then
    # Inside the session this script just created, so nothing else can be
    # providing a secret service yet.
    eval "$(gnome-keyring-daemon --start --components=secrets 2>/dev/null)" || true
    export GNOME_KEYRING_CONTROL
  fi
  exec "${binary}" "$@"
fi

# No session bus. Create one and re-enter, so the application and the keyring
# share it; a session started for the keyring alone would end with the command
# that created it.
if command -v dbus-run-session >/dev/null 2>&1; then
  OPSCAPSULE_SESSION=1
  export OPSCAPSULE_SESSION
  exec dbus-run-session -- "$0" "$@"
fi

# Without dbus-run-session there is nothing to arrange. The application starts
# and reports that credentials cannot be stored, which is accurate.
exec "${binary}" "$@"

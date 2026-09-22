# Packaging OpsCapsule

OpsCapsule currently packages a macOS application bundle and can make ZIP and
DMG artifacts with Electron Forge. This is the packaging foundation, not yet a
public release pipeline: release signing, notarization, update metadata, and
GitHub release publishing are deliberately left for the next slice.

## Runtime boundary

The packaged application uses Electron's embedded Node.js runtime for its own
main process, preload, sandbox orchestration, and terminal utility process. It
does not invoke a separately installed Node.js executable for those components.
The `RunAsNode` Electron fuse stays disabled.

Configured agent commands remain external tools. An OpenCode, Claude Code, or
custom agent installation may itself depend on a runtime supplied by the user;
OpsCapsule does not bundle those third-party agents or their SDKs.

## Build prerequisites

- macOS for the current artifact targets;
- Node.js 24 and npm;
- Xcode Command Line Tools, used to rebuild `node-pty`; and
- normal access to macOS application and disk-image services when making or
  running artifacts.

For a Homebrew installation where a newer Node.js is currently linked, install
the keg-only Node.js 24 formula and put it first on `PATH` for the shell used to
build OpsCapsule:

```sh
brew install node@24
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
hash -r
node --version # must report v24.x
```

Install dependencies and build an application bundle:

```sh
npm install
npm run package
```

The application is written beneath `out/`, for example:

```text
out/OpsCapsule-darwin-arm64/OpsCapsule.app
```

Create the configured ZIP and DMG distributables with:

```sh
npm run make && npm run verify:package
```

Verification must follow packaging: it inspects and launches the application in
`out/` and therefore cannot run before `npm run package` or `npm run make` has
completed. The package, make, verification, and install scripts stop immediately
with an actionable message when the active Node.js major is not 24.

Forge downloads Electron when it is not already cached. A dedicated cache can
be selected for repeatable local or CI builds:

```sh
OPSCAPSULE_ELECTRON_CACHE=/path/to/cache npm run package
```

## Package verification

To build and immediately verify an application bundle, run:

```sh
npm run package && npm run verify:package
```

This verifies the bundle layout, code-signing structure, Electron fuse values,
unpacked `node-pty` and Sandbox Runtime resources, and a hidden launch of the
real packaged renderer and terminal utility process. The launch uses an isolated
temporary user-data directory and a minimal `PATH`, which proves that the
application-owned terminal worker does not fall back to a system Node.js.

macOS process sandboxes that prohibit application registration cannot launch an
`.app` bundle. In that specific environment, the non-launching checks are still
available:

```sh
npm run verify:package -- --static-only
```

The complete verification must still run in a normal macOS session or release
CI before an artifact is published.

## Package structure and hardening

- Application JavaScript is stored in `app.asar`.
- The native `node-pty` addon, its helper executable, and Sandbox Runtime vendor
  resources are unpacked to real filesystem paths.
- Production dependencies are packaged; source files, tests, docs, build
  scripts, examples, caches, and development dependencies are excluded.
- All Electron 44 fuses are set explicitly. In particular, `RunAsNode`,
  `NODE_OPTIONS`, CLI inspection, and extra `file:` privileges are disabled;
  ASAR integrity and loading only from the embedded ASAR are enabled.
- The renderer is served from the restricted `opscapsule://app/` protocol, so
  disabling Electron's elevated `file:` privileges does not break packaged
  assets or grant renderer pages access to arbitrary local files.
- Local macOS bundles receive an ad-hoc signature so their nested code structure
  can be verified. This is not a trusted public release signature.

Before public distribution, replace the local ad-hoc configuration with a
Developer ID Application identity, enable and validate hardened runtime
entitlements, notarize and staple the app/DMG, and test the downloaded artifact
on a clean machine. Windows and Linux makers, signing, and package-level smoke
tests remain separate platform slices.

The runtime dependency audit is clean (`npm audit --omit=dev`). At the time this
foundation was added, the latest Electron Forge 7 toolchain still reported
development-only advisories through its packaging and legacy DMG dependencies.
Those packages are not included in the application, but they do execute while a
release is built. Public release jobs should therefore run on isolated,
ephemeral runners, and the toolchain advisories must be reviewed again before
publishing.

# Packaging OpsCapsule

OpsCapsule packages a macOS application bundle and makes ZIP and DMG artifacts
with Electron Forge. The release workflow can publish those artifacts as an
ad-hoc-signed, unnotarized GitHub prerelease for Apple Silicon. Trusted
Developer ID signing, notarization, update metadata, and additional platform
artifacts remain future work.

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

## Preview releases

The `Release` GitHub Actions workflow has two modes:

- a manual run builds and verifies the current revision, then retains the
  ad-hoc-signed artifacts for 14 days without creating a GitHub release; and
- pushing a version tag builds the same artifacts, records their provenance,
  and publishes a GitHub prerelease.

The workflow runs on an ephemeral Apple Silicon `macos-15` runner. It installs
the locked dependency graph, audits runtime dependencies, runs the automated
tests, builds the DMG and ZIP, launches the packaged application as a smoke
test, verifies both distributable containers, writes `SHA256SUMS.txt`, and
attests the two application artifacts before publishing them.

A release tag must exactly match the version in `package.json`, and its commit
must be contained in `main`. For example, after a version change has been
reviewed and merged:

```sh
git switch main
git pull --ff-only
git tag -s v0.4.0 -m "OpsCapsule v0.4.0"
git push origin v0.4.0
```

Use the repository's **Actions → Release → Run workflow** control to exercise
the entire build without publishing before creating the tag. A failed tag build
does not create a release.

The published filenames contain `ad-hoc` intentionally. After downloading the
files, verify them from the same directory:

```sh
shasum -a 256 -c SHA256SUMS.txt
gh attestation verify OpsCapsule-macos-arm64-0.4.0-ad-hoc.dmg \
  --repo erikeverts/OpsCapsule
```

Because the app is not signed with a Developer ID identity or notarized, macOS
cannot establish its developer identity and Gatekeeper will block its first
launch. Only continue for a build you trust and have verified. After attempting
to open OpsCapsule, approve it under **System Settings → Privacy & Security →
Open Anyway**. Organization-managed Macs may disallow that override.

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

## Host tool discovery

A packaged application opened from Finder or the Dock does not reliably inherit
the same executable search path as a terminal. At startup OpsCapsule reads only
`PATH` from the user's bounded interactive login shell and merges it with safe
platform defaults. It never imports the rest of the shell environment. The
fallbacks include Homebrew's Apple Silicon and Intel locations and the standard
user-local launcher directory `~/.local/bin` used by native Claude Code.

The resulting path is the single source for readiness checks, AWS credential
resolution, sandbox prerequisites, agent launch, and capsule shells. Relative
entries are discarded. If the selected agent is installed below the user's home
directory, enforced isolation grants read access only to the resolved launcher
and its symbolic-link chain. For example, native Claude Code exposes
`~/.local/bin/claude` as a link to one versioned executable below
`~/.local/share/claude/versions`; the rest of the home directory stays denied.

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
- Local and preview-release macOS bundles receive an ad-hoc signature so their
  nested code structure can be verified. This is not a trusted public release
  signature and does not establish the publisher's identity.

Before calling the application production-ready, replace the ad-hoc
configuration with a Developer ID Application identity, enable and validate
hardened runtime entitlements, notarize and staple the app/DMG, and test the
downloaded artifact on a clean machine. Windows and Linux makers, signing, and
package-level smoke tests remain separate platform slices.

Runtime dependencies are checked in both CI and the release workflow with
`npm run audit:runtime`. High and critical advisories fail the build unless the
specific advisory is recorded in `security/accepted-advisories.json` with a
reachability assessment and a review deadline. Unknown advisories and expired
or obsolete acceptances fail closed; the severity threshold is never lowered to
make one dependency pass.

The Sandbox Runtime currently reaches `node-forge` only through its certificate
generation path, while the outstanding advisory affects signature verification.
That advisory is accepted temporarily with its reasoning and deadline in the
policy file. Sandbox Runtime's Zod dependency is forced to reuse OpsCapsule's
patched Zod 4 version; the runtime imports the documented `zod/v3` compatibility
surface, so a vulnerable private Zod 3 copy is not shipped.

Electron Forge still reports development-only advisories through packaging and
legacy DMG dependencies. Those packages are not included in the application,
but they execute while a release is built. Release jobs therefore run on
isolated, ephemeral runners, and the toolchain advisories must be reviewed again
before trusted production publishing.

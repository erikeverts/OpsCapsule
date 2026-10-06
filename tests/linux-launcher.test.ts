import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * The launcher is what makes `opscapsule` work on a host with no desktop
 * session. Running it against a stand-in binary proves the branches without
 * needing Linux, since the decisions are made in shell before the application
 * is reached.
 */
async function launcherIn(directory: string): Promise<string> {
  const launcher = join(directory, "opscapsule-launcher");
  await copyFile(
    new URL("../build/linux-launcher.sh", import.meta.url),
    launcher,
  );
  await chmod(launcher, 0o755);
  // Stands in for the Electron binary, reporting what it was given.
  const binary = join(directory, "OpsCapsule");
  await writeFile(
    binary,
    '#!/bin/sh\necho "started session=${OPSCAPSULE_SESSION:-none} bus=${DBUS_SESSION_BUS_ADDRESS:-none} args=$*"\n',
  );
  await chmod(binary, 0o755);
  return launcher;
}

describe("the Linux launcher", () => {
  it("hands over untouched when a session already exists", async () => {
    const launcher = await launcherIn(await mkdtemp("/tmp/oc-launch-"));
    const { stdout } = await run(launcher, ["--flag"], {
      env: { PATH: process.env.PATH!, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
    });
    // A desktop manages its own session; the launcher must not interfere.
    expect(stdout).toContain("bus=unix:path=/run/user/1000/bus");
    expect(stdout).toContain("session=none");
    expect(stdout).toContain("args=--flag");
  });

  it("starts the application anyway when no session can be arranged", async () => {
    const launcher = await launcherIn(await mkdtemp("/tmp/oc-launch-"));
    // An empty PATH means no dbus-run-session. Refusing to start would be
    // worse than starting and reporting that credentials cannot be stored.
    const { stdout } = await run(launcher, [], { env: { PATH: "/usr/bin:/bin" } });
    expect(stdout).toContain("started");
  });

  it("creates a session and re-enters when there is none", async () => {
    const directory = await mkdtemp("/tmp/oc-launch-");
    const launcher = await launcherIn(directory);
    // Stands in for dbus-run-session: sets a bus address and runs what follows,
    // which is how the real one behaves from the launcher's point of view.
    const fakeBin = join(directory, "bin");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "dbus-run-session"),
      '#!/bin/sh\nshift\nDBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/fake-bus\nexport DBUS_SESSION_BUS_ADDRESS\nexec "$@"\n',
    );
    await chmod(join(fakeBin, "dbus-run-session"), 0o755);

    const { stdout } = await run(launcher, ["--flag"], {
      env: { PATH: `${fakeBin}:/usr/bin:/bin` },
    });

    // The application must end up inside the session that was created, not
    // beside it, because that is the whole point of the arrangement.
    expect(stdout).toContain("bus=unix:path=/tmp/fake-bus");
    expect(stdout).toContain("session=1");
    expect(stdout).toContain("args=--flag");
  });

  it("does not loop when the created session still reports no bus", async () => {
    const directory = await mkdtemp("/tmp/oc-launch-");
    const launcher = await launcherIn(directory);
    // A dbus-run-session that fails to set an address would re-enter forever
    // if the launcher trusted the bus variable alone.
    const fakeBin = join(directory, "bin");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "dbus-run-session"),
      '#!/bin/sh\nshift\nexec "$@"\n',
    );
    await chmod(join(fakeBin, "dbus-run-session"), 0o755);

    const { stdout } = await run(launcher, [], {
      env: { PATH: `${fakeBin}:/usr/bin:/bin` },
    });
    expect(stdout).toContain("started");
  }, 10_000);

  it("passes arguments through in every path", async () => {
    const launcher = await launcherIn(await mkdtemp("/tmp/oc-launch-"));
    const { stdout } = await run(launcher, ["--one", "--two"], {
      env: { PATH: process.env.PATH!, DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" },
    });
    expect(stdout).toContain("args=--one --two");
  });
});

describe("the launcher's name", () => {
  it("differs from the binary by more than case", async () => {
    // These sit in one directory. Differing only by case makes them the same
    // file on a case-insensitive filesystem, where the launcher silently
    // overwrites the binary it is supposed to start.
    const config = await import("../forge.config.cjs");
    const forge = (config.default ?? config) as {
      packagerConfig: { executableName: string };
      makers: { name: string; config?: { options?: { bin?: string } } }[];
    };
    const deb = forge.makers.find((maker) => maker.name.includes("deb"));
    const launcher = deb?.config?.options?.bin;
    const binary = forge.packagerConfig.executableName;

    expect(launcher).toBeDefined();
    expect(launcher!.toLowerCase()).not.toBe(binary.toLowerCase());
  });
});

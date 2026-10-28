import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectHostGitConfiguration,
  preferDirectMacOsGitExecutable,
  writeHostGitConfiguration,
  type HostGitConfiguration,
} from "../src/main/git-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscapsule-git-config-"));
  temporaryDirectories.push(root);
  return root;
}

function git(args: string[], environment: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: environment,
  }).trim();
}

describe("host Git configuration", () => {
  it("replaces Apple's Git launcher with the selected direct toolchain binary", async () => {
    const root = await temporaryRoot();
    const direct = join(root, "developer-git");
    await writeFile(direct, "direct Git fixture\n");
    await chmod(direct, 0o755);

    expect(
      await preferDirectMacOsGitExecutable(
        "/usr/bin/git",
        { PATH: "/usr/bin" },
        "darwin",
        async () => direct,
      ),
    ).toBe(direct);
  });

  it("leaves non-Apple and non-macOS Git executables unchanged", async () => {
    const locate = async (): Promise<string> => {
      throw new Error("must not locate a developer tool");
    };
    expect(
      await preferDirectMacOsGitExecutable(
        "/opt/homebrew/bin/git",
        {},
        "darwin",
        locate,
      ),
    ).toBe("/opt/homebrew/bin/git");
    expect(
      await preferDirectMacOsGitExecutable(
        "/usr/bin/git",
        {},
        "linux",
        locate,
      ),
    ).toBe("/usr/bin/git");
  });

  it("asks Git for global and includeIf-resolved repository identities", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const workRepository = join(root, "work-repository");
    const personalRepository = join(root, "personal-repository");
    const workIdentity = join(root, "work.gitconfig");
    const personalIdentity = join(root, "personal.gitconfig");
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(workRepository, { recursive: true }),
      mkdir(personalRepository, { recursive: true }),
    ]);
    const environment = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    git(["init", "--quiet", workRepository], environment);
    git(["init", "--quiet", personalRepository], environment);
    git(["config", "--global", "user.name", "Default User"], environment);
    git(["config", "--global", "user.email", "default@example.test"], environment);
    git(["config", "--global", "credential.helper", "osxkeychain"], environment);
    git(["config", "--global", "core.hooksPath", join(root, "private-hooks")], environment);
    git(["config", "--global", "commit.gpgSign", "true"], environment);
    git(["config", "--global", "user.signingKey", "PRIVATE-KEY-ID"], environment);
    git(["config", "--file", workIdentity, "user.name", "Work User"], environment);
    git(["config", "--file", workIdentity, "user.email", "work@example.test"], environment);
    git(["config", "--file", personalIdentity, "user.name", "Personal User"], environment);
    git(["config", "--file", personalIdentity, "user.email", "personal@example.test"], environment);
    const workGitDirectory = git(
      ["-C", workRepository, "rev-parse", "--absolute-git-dir"],
      environment,
    );
    const personalGitDirectory = git(
      ["-C", personalRepository, "rev-parse", "--absolute-git-dir"],
      environment,
    );
    git(
      [
        "config",
        "--global",
        `includeIf.gitdir:${workGitDirectory}.path`,
        workIdentity,
      ],
      environment,
    );
    git(
      [
        "config",
        "--global",
        `includeIf.gitdir:${personalGitDirectory}.path`,
        personalIdentity,
      ],
      environment,
    );

    const inspected = await inspectHostGitConfiguration(
      [
        {
          id: "work-repository",
          name: "Work repository",
          path: workRepository,
          access: "read-write",
          aliases: [],
        },
        {
          id: "personal-repository",
          name: "Personal repository",
          path: personalRepository,
          access: "read-write",
          aliases: [],
        },
      ],
      {
        ...environment,
        // The inspector must discard one-off Git overrides inherited from a
        // launching terminal.
        GIT_CONFIG_GLOBAL: join(root, "must-not-be-read"),
      },
    );

    expect(inspected.global).toEqual({
      name: "Default User",
      email: "default@example.test",
    });
    expect(inspected.repositories).toHaveLength(2);
    expect(inspected.repositories[0]?.identity).toEqual({
      name: "Work User",
      email: "work@example.test",
    });
    expect(inspected.repositories[1]?.identity).toEqual({
      name: "Personal User",
      email: "personal@example.test",
    });

    const generated = await writeHostGitConfiguration(
      join(root, "runtime"),
      inspected,
    );
    const generatedContents = await readFile(generated, "utf8");
    expect(generatedContents).not.toMatch(
      /^\s*(?:\[credential|hooksPath\s*=|gpgSign\s*=|signingKey\s*=)/im,
    );
    expect(generatedContents).not.toMatch(/PRIVATE-KEY-ID|private-hooks/);
  });

  it("writes an allowlisted global config with per-repository identities", async () => {
    const root = await temporaryRoot();
    const runtimeRoot = join(root, "runtime");
    const repository = join(root, "repository");
    const home = join(root, "capsule-home");
    await Promise.all([
      mkdir(runtimeRoot, { recursive: true }),
      mkdir(repository, { recursive: true }),
      mkdir(home, { recursive: true }),
    ]);
    const environment = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    git(["init", "--quiet", repository], environment);
    const gitDirectory = git(
      ["-C", repository, "rev-parse", "--absolute-git-dir"],
      environment,
    );
    const configuration: HostGitConfiguration = {
      executable: "git",
      global: {
        name: "Default \"Operator\"",
        email: "default@example.test",
      },
      repositories: [
        {
          configuredDirectory: repository,
          repositoryRoot: repository,
          gitDirectory,
          identity: { name: "Work User", email: "work@example.test" },
        },
      ],
    };

    const config = await writeHostGitConfiguration(runtimeRoot, configuration);
    const capsuleEnvironment = {
      ...environment,
      GIT_CONFIG_GLOBAL: config,
    };

    expect(git(["config", "--global", "--get", "user.name"], capsuleEnvironment)).toBe(
      'Default "Operator"',
    );
    expect(git(["-C", repository, "config", "--get", "user.email"], capsuleEnvironment)).toBe(
      "work@example.test",
    );
    expect(await readFile(config, "utf8")).not.toMatch(
      /^\s*(credential|hooksPath|sshCommand)\s*=/im,
    );
    if (process.platform !== "win32") {
      expect((await stat(config)).mode & 0o777).toBe(0o600);
    }
  });
});

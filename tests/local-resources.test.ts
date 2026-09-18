import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  discoverAwsProfiles,
  discoverAgentConfigurationFiles,
  discoverKubernetesContexts,
  extractAwsProfile,
  inspectAgentConfigurationFile,
  inspectDirectory,
  writeExtractedKubeconfig,
} from "../src/main/local-resources.js";
import {
  identifierFromName,
  uniqueIdentifier,
} from "../src/shared/identifiers.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscapsule-resources-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("generated identifiers", () => {
  it("normalizes names and adds deterministic collision suffixes", () => {
    expect(identifierFromName("  My_Project / Dev  ")).toBe("my-project-dev");
    expect(identifierFromName("Crème brûlée")).toBe("creme-brulee");
    expect(uniqueIdentifier("Application", ["application"])).toBe(
      "application-2",
    );
  });
});

describe("local resource discovery", () => {
  it("discovers only supported OpenCode configuration files", async () => {
    const root = await temporaryRoot();
    const configDirectory = join(root, ".config", "opencode");
    await mkdir(configDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(configDirectory, "opencode.json"), "{}\n"),
      writeFile(join(configDirectory, "tui.json"), "{}\n"),
      writeFile(join(configDirectory, "auth.json"), '{"secret":"no"}\n'),
    ]);

    const files = await discoverAgentConfigurationFiles(root);

    expect(files.map(({ path }) => path)).toEqual([
      join(configDirectory, "opencode.json"),
      join(configDirectory, "tui.json"),
    ]);
    expect(files.some(({ path }) => path.endsWith("auth.json"))).toBe(false);
  });

  it("discovers Claude Code settings without importing credentials or history", async () => {
    const root = await temporaryRoot();
    const configDirectory = join(root, ".claude");
    await mkdir(configDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(configDirectory, "settings.json"), '{"hooks":{}}\n'),
      writeFile(join(configDirectory, ".credentials.json"), '{"token":"no"}\n'),
      writeFile(join(configDirectory, "history.jsonl"), '{}\n'),
    ]);

    const files = await discoverAgentConfigurationFiles(root);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      adapter: "claude-code",
      destination: ".claude/settings.json",
    });
    expect(files[0]?.warnings.map(({ category }) => category)).toContain("hooks");
  });

  it("reports structured concerns without returning configuration values", async () => {
    const root = await temporaryRoot();
    const config = join(root, "settings.json");
    await writeFile(
      config,
      JSON.stringify({
        env: { API_TOKEN: "must-not-leak", AWS_PROFILE: "wrong-target" },
        hooks: { PreToolUse: [{ command: "review-command" }] },
        mcpServers: { tickets: { command: "ticket-mcp" } },
        enabledPlugins: { example: true },
      }),
    );

    const inspection = await inspectAgentConfigurationFile(config);

    expect(inspection.warnings.map(({ category }) => category)).toEqual(
      expect.arrayContaining([
        "identity",
        "credentials",
        "hooks",
        "mcp",
        "plugins",
      ]),
    );
    expect(JSON.stringify(inspection)).not.toContain("must-not-leak");
    expect(JSON.stringify(inspection)).not.toContain("review-command");
    expect(JSON.stringify(inspection)).not.toContain("wrong-target");
  });

  it("discovers AWS profiles and copies only the selected dependency chain", async () => {
    const root = await temporaryRoot();
    const configFile = join(root, "aws-config");
    await writeFile(
      configFile,
      [
        "[profile development]",
        "sso_session = company",
        "sso_account_id = 111122223333",
        "region = eu-west-1",
        "aws_access_key_id = must-not-be-copied",
        "aws_secret_access_key = also-must-not-be-copied",
        "",
        "[profile production]",
        "sso_session = company",
        "sso_account_id = 999900001111",
        "region = us-east-1",
        "",
        "[sso-session company]",
        "sso_start_url = https://example.awsapps.com/start",
        "sso_region = eu-west-1",
        "",
      ].join("\n"),
    );

    const profiles = await discoverAwsProfiles({ AWS_CONFIG_FILE: configFile });
    expect(profiles).toEqual([
      {
        name: "development",
        configFile,
        region: "eu-west-1",
        accountId: "111122223333",
      },
      {
        name: "production",
        configFile,
        region: "us-east-1",
        accountId: "999900001111",
      },
    ]);

    const extracted = await extractAwsProfile(configFile, "development");
    expect(extracted).toContain("[profile development]");
    expect(extracted).toContain("[sso-session company]");
    expect(extracted).not.toContain("[profile production]");
    expect(extracted).not.toContain("must-not-be-copied");
  });

  it("discovers and extracts one Kubernetes context", async () => {
    const root = await temporaryRoot();
    const kubeconfig = join(root, "config");
    const destination = join(root, "managed", "config.yaml");
    await mkdir(join(root, "managed"), { recursive: true });
    await writeFile(
      kubeconfig,
      stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          { name: "dev", cluster: { server: "https://dev.invalid" } },
          { name: "prod", cluster: { server: "https://prod.invalid" } },
        ],
        contexts: [
          {
            name: "development",
            context: { cluster: "dev", user: "dev", namespace: "apps" },
          },
          { name: "production", context: { cluster: "prod", user: "prod" } },
        ],
        users: [
          { name: "dev", user: { token: "dev-token" } },
          { name: "prod", user: { token: "prod-token" } },
        ],
        "current-context": "development",
      }),
    );

    const contexts = await discoverKubernetesContexts({ KUBECONFIG: kubeconfig });
    expect(contexts[0]).toMatchObject({
      name: "development",
      namespace: "apps",
      current: true,
    });
    await writeExtractedKubeconfig({
      sourcePath: kubeconfig,
      context: "production",
      destination,
    });
    const extracted = await readFile(destination, "utf8");
    expect(extracted).toContain("https://prod.invalid");
    expect(extracted).toContain("prod-token");
    expect(extracted).not.toContain("https://dev.invalid");
    expect(extracted).not.toContain("dev-token");
  });

  it("recognizes a version-controlled parent directory", async () => {
    const root = await temporaryRoot();
    const nested = join(root, "packages", "service");
    await Promise.all([
      mkdir(join(root, ".git"), { recursive: true }),
      mkdir(nested, { recursive: true }),
    ]);

    await expect(inspectDirectory(nested)).resolves.toEqual({
      path: nested,
      versionControl: { type: "git", root: await realpath(root) },
    });
  });
});

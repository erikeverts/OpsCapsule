import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
} from "node:path";
import { parse, stringify } from "yaml";
import { discoverAgentLogins } from "./credentials/agent-logins.js";
import type {
  AgentConfigurationFileOption,
  AgentConfigurationInspection,
  AgentConfigurationWarning,
  AwsProfileOption,
  DirectoryInspection,
  KubernetesContextOption,
  LocalResourceOptions,
  VersionControlSummary,
} from "../shared/contracts.js";

interface IniSection {
  name: string;
  lines: string[];
  values: Map<string, string>;
}

interface KubeconfigDocument {
  apiVersion?: string;
  kind?: string;
  clusters?: Array<{ name: string; cluster: Record<string, unknown> }>;
  contexts?: Array<{ name: string; context: Record<string, unknown> }>;
  users?: Array<{ name: string; user: Record<string, unknown> }>;
  "current-context"?: string;
}

function iniSections(content: string): IniSection[] {
  const sections: IniSection[] = [];
  let current: IniSection | undefined;
  for (const line of content.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)]\s*(?:[#;].*)?$/);
    if (header?.[1]) {
      current = { name: header[1].trim(), lines: [line], values: new Map() };
      sections.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    current.lines.push(line);
    const value = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/);
    if (value?.[1] && value[2] !== undefined) {
      current.values.set(value[1].toLowerCase(), value[2]);
    }
  }
  return sections;
}

function awsProfileName(sectionName: string): string | undefined {
  if (sectionName === "default") {
    return "default";
  }
  return sectionName.startsWith("profile ")
    ? sectionName.slice("profile ".length).trim()
    : undefined;
}

const awsCredentialKeys = new Set([
  "aws_access_key_id",
  "aws_secret_access_key",
  "aws_session_token",
]);

function sanitizedAwsSection(section: IniSection): string {
  return [`[${section.name}]`, ...section.lines.slice(1)]
    .filter((line, index) => {
      if (index === 0) return true;
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed.startsWith(";")) {
        return false;
      }
      const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1]?.toLowerCase();
      return !key || !awsCredentialKeys.has(key);
    })
    .join("\n")
    .trimEnd();
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function expandUserPath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

export async function discoverAwsProfiles(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AwsProfileOption[]> {
  const configFile = expandUserPath(
    environment.AWS_CONFIG_FILE || join(homedir(), ".aws", "config"),
  );
  if (!(await readable(configFile))) {
    return [];
  }
  const sections = iniSections(await readFile(configFile, "utf8"));
  return sections.flatMap((section) => {
    const name = awsProfileName(section.name);
    if (!name) {
      return [];
    }
    const region = section.values.get("region") ?? section.values.get("sso_region");
    const accountId = section.values.get("sso_account_id");
    return [{ name, configFile, region, accountId }];
  }).sort((left, right) => left.name.localeCompare(right.name));
}

export async function extractAwsProfile(
  sourcePath: string,
  profile: string,
): Promise<string> {
  const sections = iniSections(await readFile(sourcePath, "utf8"));
  const byName = new Map(sections.map((section) => [section.name, section]));
  const rootName = profile === "default" ? "default" : `profile ${profile}`;
  if (!byName.has(rootName)) {
    throw new Error(`AWS profile '${profile}' was not found in ${sourcePath}`);
  }

  const selected: IniSection[] = [];
  const visited = new Set<string>();
  const include = (sectionName: string): void => {
    if (visited.has(sectionName)) {
      return;
    }
    const section = byName.get(sectionName);
    if (!section) {
      throw new Error(
        `AWS profile '${profile}' references missing section [${sectionName}]`,
      );
    }
    visited.add(sectionName);
    selected.push(section);
    const sourceProfile = section.values.get("source_profile");
    const ssoSession = section.values.get("sso_session");
    const services = section.values.get("services");
    if (sourceProfile) {
      include(sourceProfile === "default" ? "default" : `profile ${sourceProfile}`);
    }
    if (ssoSession) {
      include(`sso-session ${ssoSession}`);
    }
    if (services) {
      include(`services ${services}`);
    }
  };
  include(rootName);
  return `${selected.map(sanitizedAwsSection).join("\n\n")}\n`;
}

function kubeconfigPaths(environment: NodeJS.ProcessEnv): string[] {
  const configured = environment.KUBECONFIG;
  return configured
    ? configured
        .split(delimiter)
        .filter(Boolean)
        .map(expandUserPath)
    : [join(homedir(), ".kube", "config")];
}

export async function discoverKubernetesContexts(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<KubernetesContextOption[]> {
  const options: KubernetesContextOption[] = [];
  for (const path of kubeconfigPaths(environment)) {
    if (!(await readable(path))) {
      continue;
    }
    const source = parse(await readFile(path, "utf8")) as KubeconfigDocument;
    for (const context of source.contexts ?? []) {
      options.push({
        name: context.name,
        path,
        cluster:
          typeof context.context.cluster === "string"
            ? context.context.cluster
            : undefined,
        namespace:
          typeof context.context.namespace === "string"
            ? context.context.namespace
            : undefined,
        current: source["current-context"] === context.name,
      });
    }
  }
  return options.sort(
    (left, right) =>
      Number(right.current) - Number(left.current) ||
      left.name.localeCompare(right.name),
  );
}

export async function discoverAgentConfigurationFiles(
  homeDirectory = homedir(),
): Promise<
  AgentConfigurationFileOption[]
> {
  const candidates: AgentConfigurationFileOption[] = [
    {
      adapter: "opencode",
      name: "OpenCode settings",
      path: join(homeDirectory, ".config", "opencode", "opencode.json"),
      destination: ".config/opencode/opencode.json",
      warnings: [],
    },
    {
      adapter: "opencode",
      name: "OpenCode terminal settings",
      path: join(homeDirectory, ".config", "opencode", "tui.json"),
      destination: ".config/opencode/tui.json",
      warnings: [],
    },
    {
      adapter: "claude-code",
      name: "Claude Code settings",
      path: join(homeDirectory, ".claude", "settings.json"),
      destination: ".claude/settings.json",
      warnings: [],
    },
  ];
  const discovered = await Promise.all(
    candidates.map(async (candidate) => {
      if (!(await readable(candidate.path))) {
        return undefined;
      }
      try {
        const inspection = await inspectAgentConfigurationFile(candidate.path);
        return { ...candidate, warnings: inspection.warnings };
      } catch {
        return {
          ...candidate,
          warnings: [
            {
              category: "unparsed" as const,
              severity: "warning" as const,
              message: "The file could not be inspected; review it before importing.",
            },
          ],
        };
      }
    }),
  );
  return discovered.filter(
    (candidate): candidate is AgentConfigurationFileOption => Boolean(candidate),
  );
}

const configurationConcernPatterns: Array<{
  category: AgentConfigurationWarning["category"];
  severity: AgentConfigurationWarning["severity"];
  pattern: RegExp;
  message: string;
}> = [
  {
    category: "identity",
    severity: "danger",
    pattern: /(?:^|[._-])(?:home|kubeconfig|aws[_-]?(?:profile|default[_-]?profile|access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token)|xdg[_-]?(?:config|data|cache|state)[_-]?home|tmpdir|claude[_-]?config[_-]?dir|opscapsule[_-][a-z0-9_-]+)(?:$|[._-])/i,
    message: "Settings may override capsule-managed identity or isolation paths.",
  },
  {
    category: "credentials",
    severity: "danger",
    pattern: /(?:^|[._-])(?:api[_-]?key|access[_-]?key|token|secret|password|credentials?|authentication|auth)(?:$|[._-])/i,
    message: "Potential credential or authentication settings are present.",
  },
  {
    category: "hooks",
    severity: "warning",
    pattern: /(?:^|[._-])(?:hooks?|commands?|scripts?)(?:$|[._-])/i,
    message: "Executable hooks or commands may be declared.",
  },
  {
    category: "plugins",
    severity: "warning",
    pattern: /(?:plugin|marketplace)/i,
    message: "Plugin or marketplace configuration is present.",
  },
  {
    category: "mcp",
    severity: "warning",
    pattern: /(?:^|[._-])mcp(?:servers?)?(?:$|[._-])/i,
    message: "MCP server configuration is present.",
  },
];

function configurationKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      configurationKeys(item, `${prefix}.${index}`),
    );
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [path, ...configurationKeys(child, path)];
    },
  );
}

export async function inspectAgentConfigurationFile(
  path: string,
): Promise<AgentConfigurationInspection> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`Agent configuration is not a regular file: ${path}`);
  }
  if (info.size > 1_000_000) {
    return {
      path,
      warnings: [
        {
          category: "unparsed",
          severity: "warning",
          message: "The file is larger than 1 MB and was not inspected.",
        },
      ],
    };
  }

  const content = await readFile(path, "utf8");
  let keys: string[];
  const warnings: AgentConfigurationWarning[] = [];
  try {
    keys = configurationKeys(JSON.parse(content));
  } catch {
    keys = content.match(/[A-Za-z_$][A-Za-z0-9_$.-]*/g) ?? [];
    warnings.push({
      category: "unparsed",
      severity: "warning",
      message: "The file is not strict JSON; inspection used a conservative text scan.",
    });
  }

  for (const concern of configurationConcernPatterns) {
    if (keys.some((key) => concern.pattern.test(key))) {
      warnings.push({
        category: concern.category,
        severity: concern.severity,
        message: concern.message,
      });
    }
  }
  return { path, warnings };
}

async function stageReferencedFile(
  value: unknown,
  sourceDirectory: string,
  assetDirectory: string,
  filename: string,
  relativeReferences: boolean,
): Promise<unknown> {
  if (typeof value !== "string") {
    return value;
  }
  const sourcePath = isAbsolute(value) ? value : resolve(sourceDirectory, value);
  const destination = join(assetDirectory, filename);
  await mkdir(assetDirectory, { recursive: true, mode: 0o700 });
  await copyFile(sourcePath, destination);
  await chmod(destination, 0o600);
  return relativeReferences
    ? relative(dirname(assetDirectory), destination)
    : destination;
}

export async function extractKubeconfigContext(options: {
  sourcePath: string;
  context: string;
  namespace?: string;
  assetDirectory: string;
  relativeReferences?: boolean;
}): Promise<object> {
  const source = parse(await readFile(options.sourcePath, "utf8")) as KubeconfigDocument;
  const contextEntry = source.contexts?.find(({ name }) => name === options.context);
  if (!contextEntry) {
    throw new Error(
      `Kubernetes context '${options.context}' was not found in ${options.sourcePath}`,
    );
  }
  const clusterName = String(contextEntry.context.cluster ?? "");
  const userName = String(contextEntry.context.user ?? "");
  const clusterEntry = source.clusters?.find(({ name }) => name === clusterName);
  const userEntry = source.users?.find(({ name }) => name === userName);
  if (!clusterEntry) {
    throw new Error(`Cluster '${clusterName}' was not found in ${options.sourcePath}`);
  }
  if (!userEntry) {
    throw new Error(`User '${userName}' was not found in ${options.sourcePath}`);
  }

  const sourceDirectory = dirname(options.sourcePath);
  const cluster = { ...clusterEntry.cluster };
  cluster["certificate-authority"] = await stageReferencedFile(
    cluster["certificate-authority"],
    sourceDirectory,
    options.assetDirectory,
    "cluster-ca.pem",
    options.relativeReferences ?? false,
  );
  const user = { ...userEntry.user };
  for (const [key, filename] of [
    ["client-certificate", "client-certificate.pem"],
    ["client-key", "client-key.pem"],
    ["tokenFile", "token"],
  ] as const) {
    user[key] = await stageReferencedFile(
      user[key],
      sourceDirectory,
      options.assetDirectory,
      filename,
      options.relativeReferences ?? false,
    );
  }

  return {
    apiVersion: source.apiVersion ?? "v1",
    kind: source.kind ?? "Config",
    clusters: [{ ...clusterEntry, cluster }],
    contexts: [
      {
        ...contextEntry,
        context: {
          ...contextEntry.context,
          ...(options.namespace ? { namespace: options.namespace } : {}),
        },
      },
    ],
    "current-context": contextEntry.name,
    users: [{ ...userEntry, user }],
  };
}

export async function writeExtractedKubeconfig(options: {
  sourcePath: string;
  context: string;
  namespace?: string;
  destination: string;
}): Promise<void> {
  const config = await extractKubeconfigContext({
    ...options,
    assetDirectory: join(dirname(options.destination), "assets"),
    relativeReferences: true,
  });
  await writeFile(options.destination, stringify(config), {
    encoding: "utf8",
    mode: 0o600,
  });
}

const versionControlMarkers: Array<{
  marker: string;
  type: VersionControlSummary["type"];
}> = [
  { marker: ".git", type: "git" },
  { marker: ".svn", type: "subversion" },
  { marker: ".hg", type: "mercurial" },
  { marker: "CVS", type: "cvs" },
];

export async function inspectDirectory(path: string): Promise<DirectoryInspection> {
  const expandedPath = expandUserPath(path);
  let current = await realpath(expandedPath);
  if (!(await stat(current)).isDirectory()) {
    current = dirname(current);
  }
  const filesystemRoot = parsePath(current).root;
  while (true) {
    for (const marker of versionControlMarkers) {
      if (await readable(join(current, marker.marker))) {
        return {
          path,
          versionControl: { type: marker.type, root: current },
        };
      }
    }
    if (current === filesystemRoot) {
      return { path };
    }
    current = dirname(current);
  }
}

export async function discoverLocalResources(): Promise<LocalResourceOptions> {
  const [awsProfiles, kubernetesContexts, agentConfigurationFiles, agentLogins] =
    await Promise.all([
      discoverAwsProfiles(),
      discoverKubernetesContexts(),
      discoverAgentConfigurationFiles(),
      discoverAgentLogins(),
    ]);
  return {
    awsProfiles,
    kubernetesContexts,
    agentConfigurationFiles,
    agentLogins,
  };
}

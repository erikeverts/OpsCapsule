import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import type {
  AgentConfigurationWarning,
  TargetReadinessCheck,
  TargetReadinessReport,
} from "../shared/contracts.js";
import { checkSandboxRuntimeAvailability } from "./isolation/sandbox-runtime.js";
import { inspectAgentConfigurationFile } from "./local-resources.js";
import { resolveExecutable } from "./runtime-adapters/readiness.js";
import type { CredentialReference } from "../shared/credentials.js";
import { checkCredentialReadiness } from "./credentials/readiness.js";
import { RuntimeAdapterRegistry } from "./runtime-adapters/registry.js";
import {
  resolveConfiguredPath,
  type ResolvedWorkspaceTarget,
} from "./workspace-registry.js";

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportStatus(
  checks: TargetReadinessCheck[],
): TargetReadinessReport["status"] {
  if (checks.some(({ status }) => status === "fail")) {
    return "blocked";
  }
  if (checks.some(({ status }) => status === "warning")) {
    return "attention";
  }
  return "ready";
}

async function directoryCheck(
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<TargetReadinessCheck> {
  try {
    for (const directory of resolvedTarget.directories) {
      const canonical = await realpath(directory.path);
      const info = await lstat(canonical);
      if (!info.isDirectory()) {
        throw new Error(`${directory.path} is not a directory`);
      }
      await access(
        canonical,
        constants.R_OK |
          (directory.access === "read-write" ? constants.W_OK : 0),
      );
    }
    return {
      id: "directories",
      label: "Configured directories",
      status: "pass",
      detail: `${resolvedTarget.directories.length} declared root${resolvedTarget.directories.length === 1 ? "" : "s"} are accessible.`,
    };
  } catch (error) {
    return {
      id: "directories",
      label: "Configured directories",
      status: "fail",
      detail: detail(error),
    };
  }
}

async function configurationCheck(
  resolvedTarget: ResolvedWorkspaceTarget,
): Promise<TargetReadinessCheck> {
  const files = resolvedTarget.agent.profile.configuration.files;
  if (files.length === 0) {
    return {
      id: "configuration",
      label: "Managed agent configuration",
      status: "pass",
      detail: "No managed configuration files are required.",
    };
  }

  try {
    const warnings: AgentConfigurationWarning[] = [];
    const warningDetails: string[] = [];
    for (const file of files) {
      const path = resolveConfiguredPath(
        file.source,
        resolvedTarget.workspace.sourcePath,
      );
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`${file.source} is not a regular managed file`);
      }
      const inspection = await inspectAgentConfigurationFile(path);
      warnings.push(...inspection.warnings);
      warningDetails.push(
        ...inspection.warnings.map(
          ({ message }) => `${file.destination}: ${message}`,
        ),
      );
    }
    const categories = [...new Set(warnings.map(({ category }) => category))];
    const identityOverride = categories.includes("identity");
    return {
      id: "configuration",
      label: "Managed agent configuration",
      status: identityOverride
        ? "fail"
        : warnings.length > 0
          ? "warning"
          : "pass",
      detail:
        identityOverride
          ? "Managed settings may override capsule identity or isolation paths. Remove those keys before launch."
          : warnings.length > 0
          ? `${files.length} file${files.length === 1 ? "" : "s"} available; review ${categories.join(", ")} warnings.`
          : `${files.length} managed file${files.length === 1 ? "" : "s"} available with no detected concerns.`,
      ...(warningDetails.length > 0
        ? { details: [...new Set(warningDetails)] }
        : {}),
    };
  } catch (error) {
    return {
      id: "configuration",
      label: "Managed agent configuration",
      status: "fail",
      detail: detail(error),
    };
  }
}

export async function checkTargetReadiness(
  resolvedTarget: ResolvedWorkspaceTarget,
  adapters = new RuntimeAdapterRegistry(),
  /**
   * Whether a provider login has been imported. Supplied by the caller
   * because the credential store needs an encryptor this module has no
   * business knowing about.
   */
  hasStoredSecret?: (reference: CredentialReference) => Promise<boolean>,
): Promise<TargetReadinessReport> {
  const checks: TargetReadinessCheck[] = [];
  try {
    adapters.createAgent(resolvedTarget.agent);
    checks.push({
      id: "adapter",
      label: "Agent adapter",
      status: "pass",
      detail: `${resolvedTarget.agent.profile.adapter} is available.`,
    });
  } catch (error) {
    checks.push({
      id: "adapter",
      label: "Agent adapter",
      status: "fail",
      detail: detail(error),
    });
  }

  const configuredCommand = resolvedTarget.agent.profile.runtime.command;
  const command = configuredCommand === "$SHELL"
    ? process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/sh")
    : configuredCommand;
  try {
    const executable = await resolveExecutable(
      command,
      { PATH: process.env.PATH ?? "" },
      resolvedTarget.defaultDirectory.path,
    );
    checks.push({
      id: "executable",
      label: "Agent command",
      status: "pass",
      detail: `${configuredCommand} resolves to ${executable}.`,
    });
  } catch (error) {
    checks.push({
      id: "executable",
      label: "Agent command",
      status: "fail",
      detail: detail(error),
    });
  }

  checks.push(await configurationCheck(resolvedTarget));
  checks.push({
    id: "instructions",
    label: "Workspace instructions",
    status: resolvedTarget.workspace.manifest.agentInstructions
      ? "pass"
      : "warning",
    detail: resolvedTarget.workspace.manifest.agentInstructions
      ? "Portable instructions will be materialized for the selected adapter."
      : "No portable workspace instructions are configured.",
  });
  checks.push(await directoryCheck(resolvedTarget));

  if (resolvedTarget.target.isolation.mode === "context-only") {
    checks.push({
      id: "isolation",
      label: "Sandbox prerequisites",
      status: "warning",
      detail: "This target explicitly uses context-only mode; filesystem access is not enforced.",
    });
  } else {
    try {
      await checkSandboxRuntimeAvailability();
      checks.push({
        id: "isolation",
        label: "Sandbox prerequisites",
        status: "pass",
        detail: "The enforced isolation backend and host dependencies are available.",
      });
    } catch (error) {
      checks.push({
        id: "isolation",
        label: "Sandbox prerequisites",
        status: "fail",
        detail: detail(error),
      });
    }
  }

  // Credentials are checked last: it is the only check that reaches the
  // network, and there is no point paying for it when something earlier has
  // already blocked the launch.
  const credentials = await checkCredentialReadiness({
    ...(resolvedTarget.credentials.operational
      ? { operational: resolvedTarget.credentials.operational }
      : {}),
    ...(resolvedTarget.credentials.inference
      ? { inference: resolvedTarget.credentials.inference }
      : {}),
    hasStoredSecret: hasStoredSecret ?? (async () => false),
  });
  if (credentials) {
    checks.push(credentials);
  }

  return { status: reportStatus(checks), checks };
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimePaths, WorkspaceDefinition } from "../shared/contracts.js";

function renderKubeconfig(workspace: WorkspaceDefinition): string {
  return `apiVersion: v1
kind: Config
clusters:
  - name: ${workspace.cluster}
    cluster:
      server: https://${workspace.id}.invalid
contexts:
  - name: ${workspace.id}
    context:
      cluster: ${workspace.cluster}
      user: ${workspace.id}
      namespace: ${workspace.namespace}
current-context: ${workspace.id}
users:
  - name: ${workspace.id}
    user: {}
`;
}

export async function createWorkspaceRuntime(
  baseDirectory: string,
  workspace: WorkspaceDefinition,
): Promise<RuntimePaths> {
  const root = join(baseDirectory, "workspaces", workspace.id);
  const kubeconfig = join(root, "kubeconfig.yaml");

  await mkdir(root, { recursive: true });

  try {
    await readFile(kubeconfig, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
    await writeFile(kubeconfig, renderKubeconfig(workspace), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return { root, kubeconfig };
}

export function buildWorkspaceEnvironment(
  runtime: RuntimePaths,
  workspace: WorkspaceDefinition,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(inheritedEnvironment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

  return {
    ...environment,
    KUBECONFIG: runtime.kubeconfig,
    AWS_PROFILE: workspace.awsProfile,
    AWS_REGION: workspace.region,
    AWS_DEFAULT_REGION: workspace.region,
    OPSCAPSULE_WORKSPACE: workspace.id,
    OPSCAPSULE_ENVIRONMENT: workspace.environment,
    OPSCAPSULE_ACCOUNT_ID: workspace.accountId,
    OPSCAPSULE_CLUSTER: workspace.cluster,
    OPSCAPSULE_NAMESPACE: workspace.namespace,
  };
}


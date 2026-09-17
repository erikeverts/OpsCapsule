import type { WorkspaceDefinition } from "../shared/contracts.js";

export const WORKSPACES: WorkspaceDefinition[] = [
  {
    id: "atlas-prod",
    name: "Atlas Retail",
    environment: "production",
    awsProfile: "atlas-prod",
    accountId: "111122223333",
    region: "eu-west-1",
    cluster: "atlas-production",
    namespace: "platform",
    agentRuntime: {
      adapter: "command",
      command: "$SHELL",
      args: [],
    },
  },
  {
    id: "borealis-stage",
    name: "Borealis Health",
    environment: "staging",
    awsProfile: "borealis-stage",
    accountId: "444455556666",
    region: "eu-central-1",
    cluster: "borealis-staging",
    namespace: "services",
    agentRuntime: {
      adapter: "command",
      command: "$SHELL",
      args: [],
    },
  },
];

export function getWorkspace(workspaceId: string): WorkspaceDefinition {
  const workspace = WORKSPACES.find(({ id }) => id === workspaceId);

  if (!workspace) {
    throw new Error(`Unknown workspace: ${workspaceId}`);
  }

  return workspace;
}


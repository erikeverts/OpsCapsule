import { describe, expect, it } from "vitest";
import {
  renameAgentProfile,
  renameCloudConnection,
  renameDirectory,
  renameKubernetesContext,
  renameTarget,
} from "../src/renderer/src/workspace-draft.js";
import type { WorkspaceManifest } from "../src/shared/workspace-schema.js";

function workspace(): WorkspaceManifest {
  return {
    apiVersion: "opscapsule.dev/v1alpha1",
    kind: "Workspace",
    metadata: { id: "example", name: "Example" },
    agentProfiles: [
      {
        id: "agent",
        name: "Agent",
        adapter: "command",
        runtime: { command: "$SHELL", args: [] },
        configuration: { files: [] },
        environment: {},
      },
    ],
    defaultAgentProfile: "agent",
    cloudConnections: [
      { id: "aws", name: "AWS", provider: "aws", config: {} },
    ],
    kubernetesContexts: [
      {
        id: "cluster",
        name: "Cluster",
        source: {
          type: "generated",
          server: "https://example.invalid",
          context: "example",
        },
      },
    ],
    directories: [
      { id: "directory", name: "Directory", path: "/tmp", access: "read-write" },
    ],
    targets: [
      {
        id: "target",
        name: "Target",
        environment: "target",
        risk: "development",
        cloudConnection: "aws",
        kubernetesContext: "cluster",
        directories: ["directory"],
        defaultDirectory: "directory",
        agentRuntime: { adapter: "command", command: "$SHELL", args: [] },
        isolation: {
          mode: "context-only",
          network: { mode: "deny", allowedDomains: [] },
        },
      },
    ],
  };
}

describe("workspace draft generated ids", () => {
  it("regenerates every new resource id and updates target references", () => {
    const draft = workspace();

    renameDirectory(draft, 0, "Application Code", true);
    renameCloudConnection(draft, 0, "Production AWS", true);
    renameKubernetesContext(draft, 0, "ri-obs-use1-prd", true);
    renameTarget(draft, 0, "Production", true);
    draft.targets[0]!.agentProfile = "agent";
    renameAgentProfile(draft, 0, "OpenCode Bedrock", true);

    expect(draft.directories[0]?.id).toBe("application-code");
    expect(draft.cloudConnections[0]?.id).toBe("production-aws");
    expect(draft.kubernetesContexts[0]?.id).toBe("ri-obs-use1-prd");
    expect(draft.targets[0]).toMatchObject({
      id: "production",
      environment: "production",
      cloudConnection: "production-aws",
      kubernetesContext: "ri-obs-use1-prd",
      directories: ["application-code"],
      defaultDirectory: "application-code",
      agentProfile: "opencode-bedrock",
    });
    expect(draft.defaultAgentProfile).toBe("opencode-bedrock");
  });

  it("keeps ids stable for persisted resources", () => {
    const draft = workspace();

    renameDirectory(draft, 0, "Renamed directory", false);
    renameCloudConnection(draft, 0, "Renamed cloud", false);
    renameKubernetesContext(draft, 0, "Renamed cluster", false);
    renameTarget(draft, 0, "Renamed target", false);
    renameAgentProfile(draft, 0, "Renamed agent", false);

    expect(draft.directories[0]?.id).toBe("directory");
    expect(draft.cloudConnections[0]?.id).toBe("aws");
    expect(draft.kubernetesContexts[0]?.id).toBe("cluster");
    expect(draft.targets[0]?.id).toBe("target");
    expect(draft.agentProfiles[0]?.id).toBe("agent");
  });
});

import { uniqueIdentifier } from "../../shared/identifiers";
import type { WorkspaceManifest } from "../../shared/workspace-schema";

export interface RenameResult {
  previousId: string;
  id: string;
}

function nextId(
  name: string,
  currentId: string,
  ids: string[],
  regenerate: boolean,
): string {
  return regenerate
    ? uniqueIdentifier(
        name,
        ids.filter((id) => id !== currentId),
      )
    : currentId;
}

export function renameDirectory(
  manifest: WorkspaceManifest,
  index: number,
  name: string,
  regenerate: boolean,
): RenameResult {
  const directory = manifest.directories[index]!;
  const previousId = directory.id;
  const id = nextId(
    name,
    previousId,
    manifest.directories.map((item) => item.id),
    regenerate,
  );
  directory.name = name;
  directory.id = id;
  if (id !== previousId) {
    for (const target of manifest.targets) {
      target.directories = target.directories.map((directoryId) =>
        directoryId === previousId ? id : directoryId,
      );
      if (target.defaultDirectory === previousId) {
        target.defaultDirectory = id;
      }
    }
  }
  return { previousId, id };
}

export function renameCloudConnection(
  manifest: WorkspaceManifest,
  index: number,
  name: string,
  regenerate: boolean,
): RenameResult {
  const connection = manifest.cloudConnections[index]!;
  const previousId = connection.id;
  const id = nextId(
    name,
    previousId,
    manifest.cloudConnections.map((item) => item.id),
    regenerate,
  );
  connection.name = name;
  connection.id = id;
  if (id !== previousId) {
    for (const target of manifest.targets) {
      if (target.cloudConnection === previousId) {
        target.cloudConnection = id;
      }
    }
  }
  return { previousId, id };
}

export function renameKubernetesContext(
  manifest: WorkspaceManifest,
  index: number,
  name: string,
  regenerate: boolean,
): RenameResult {
  const context = manifest.kubernetesContexts[index]!;
  const previousId = context.id;
  const id = nextId(
    name,
    previousId,
    manifest.kubernetesContexts.map((item) => item.id),
    regenerate,
  );
  context.name = name;
  context.id = id;
  if (id !== previousId) {
    for (const target of manifest.targets) {
      if (target.kubernetesContext === previousId) {
        target.kubernetesContext = id;
      }
    }
  }
  return { previousId, id };
}

export function renameAgentProfile(
  manifest: WorkspaceManifest,
  index: number,
  name: string,
  regenerate: boolean,
): RenameResult {
  const profile = manifest.agentProfiles[index]!;
  const previousId = profile.id;
  const id = nextId(
    name,
    previousId,
    manifest.agentProfiles.map((item) => item.id),
    regenerate,
  );
  profile.name = name;
  profile.id = id;
  if (id !== previousId) {
    if (manifest.defaultAgentProfile === previousId) {
      manifest.defaultAgentProfile = id;
    }
    for (const target of manifest.targets) {
      if (target.agentProfile === previousId) {
        target.agentProfile = id;
      }
    }
  }
  return { previousId, id };
}

export function renameTarget(
  manifest: WorkspaceManifest,
  index: number,
  name: string,
  regenerate: boolean,
): RenameResult {
  const target = manifest.targets[index]!;
  const previousId = target.id;
  const id = nextId(
    name,
    previousId,
    manifest.targets.map((item) => item.id),
    regenerate,
  );
  target.name = name;
  target.id = id;
  if (id !== previousId && target.environment === previousId) {
    target.environment = id;
  }
  return { previousId, id };
}

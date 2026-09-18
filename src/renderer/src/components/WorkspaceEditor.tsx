import { useEffect, useMemo, useState } from "react";
import { stringify } from "yaml";
import { ZodError } from "zod";
import type {
  AgentConfigurationWarning,
  DirectoryInspection,
  LocalResourceOptions,
  WorkspaceDocument,
} from "../../../shared/contracts";
import {
  identifierFromName,
  uniqueIdentifier,
} from "../../../shared/identifiers";
import {
  parseWorkspaceManifest,
  type CloudConnection,
  type KubernetesContext,
  type WorkspaceManifest,
} from "../../../shared/workspace-schema";
import {
  renameAgentProfile as renameAgentProfileDraft,
  renameCloudConnection as renameCloudConnectionDraft,
  renameDirectory as renameDirectoryDraft,
  renameKubernetesContext as renameKubernetesContextDraft,
  renameTarget as renameTargetDraft,
  type RenameResult,
} from "../workspace-draft";

type EditorSection =
  | "general"
  | "directories"
  | "cloud"
  | "kubernetes"
  | "agents"
  | "targets";

interface WorkspaceEditorProps {
  mode: "create" | "edit";
  workspaceId?: string;
  onCancel: () => void;
  onSaved: (workspaceId: string) => Promise<void> | void;
}

interface AwsConfiguration extends Record<string, unknown> {
  authentication: { type: "profile"; profile: string; configFile?: string };
  expectedIdentity: { accountId: string };
  defaults: { region: string };
}

const editorSections: Array<{
  id: EditorSection;
  label: string;
  description: string;
}> = [
  { id: "general", label: "General", description: "Identity and description" },
  { id: "directories", label: "Directories", description: "Filesystem access" },
  { id: "cloud", label: "Cloud", description: "Accounts and identities" },
  { id: "kubernetes", label: "Kubernetes", description: "Cluster contexts" },
  { id: "agents", label: "Agents", description: "Profiles and configuration" },
  { id: "targets", label: "Targets", description: "Operational environments" },
];

function blankWorkspace(): WorkspaceManifest {
  return {
    apiVersion: "opscapsule.dev/v1alpha1",
    kind: "Workspace",
    metadata: {
      id: "new-workspace",
      name: "New workspace",
    },
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
    cloudConnections: [],
    kubernetesContexts: [],
    directories: [
      {
        id: "workspace",
        name: "Workspace",
        path: "",
        access: "read-write",
      },
    ],
    targets: [
      {
        id: "development",
        name: "Development",
        environment: "development",
        risk: "development",
        directories: ["workspace"],
        defaultDirectory: "workspace",
        isolation: {
          mode: "enforced",
          network: { mode: "public", allowedDomains: [] },
        },
      },
    ],
  };
}

function describeValidationError(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return issue
      ? `${issue.path.join(".") || "manifest"}: ${issue.message}`
      : "The workspace is invalid";
  }
  return error instanceof Error ? error.message : String(error);
}

function awsConfiguration(connection: CloudConnection): AwsConfiguration {
  const config = connection.config as Partial<AwsConfiguration>;
  return {
    authentication: {
      type: "profile",
      profile: config.authentication?.profile ?? "",
      ...(config.authentication?.configFile
        ? { configFile: config.authentication.configFile }
        : {}),
    },
    expectedIdentity: {
      accountId: config.expectedIdentity?.accountId ?? "",
    },
    defaults: { region: config.defaults?.region ?? "" },
  };
}

function matchesKubernetesOption(
  option: LocalResourceOptions["kubernetesContexts"][number],
  source: KubernetesContext["source"],
): boolean {
  return (
    source.type === "kubeconfig" &&
    option.path === source.path &&
    option.name === source.context
  );
}

function environmentText(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

function parseEnvironmentText(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0
          ? [line.trim(), ""]
          : [line.slice(0, separator).trim(), line.slice(separator + 1)];
      })
      .filter(([name]) => Boolean(name)),
  );
}

function attachDiscoveredAwsConfigs(
  current: WorkspaceManifest,
  resources: LocalResourceOptions,
): WorkspaceManifest {
  const next = structuredClone(current);
  let changed = false;
  for (const connection of next.cloudConnections) {
    if (connection.provider !== "aws") {
      continue;
    }
    const config = awsConfiguration(connection);
    if (config.authentication.configFile) {
      continue;
    }
    const matches = resources.awsProfiles.filter(
      ({ name }) => name === config.authentication.profile,
    );
    const profile = matches.length === 1 ? matches[0] : undefined;
    if (!profile) {
      continue;
    }
    config.authentication.configFile = profile.configFile;
    config.defaults.region ||= profile.region ?? "";
    config.expectedIdentity.accountId ||= profile.accountId ?? "";
    connection.config = config;
    changed = true;
  }
  return changed ? next : current;
}

function validateDraft(draft: WorkspaceManifest): string | null {
  try {
    parseWorkspaceManifest(draft);
    for (const connection of draft.cloudConnections) {
      if (connection.provider !== "aws") {
        continue;
      }
      const config = awsConfiguration(connection);
      if (!config.authentication.profile) {
        return `Cloud connection '${connection.id}' needs an AWS profile`;
      }
      if (!/^\d{12}$/.test(config.expectedIdentity.accountId)) {
        return `Cloud connection '${connection.id}' needs a 12-digit AWS account id`;
      }
      if (!config.defaults.region) {
        return `Cloud connection '${connection.id}' needs an AWS region`;
      }
    }
    return null;
  } catch (error) {
    return describeValidationError(error);
  }
}

function EditorSectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="editor-section-header">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}

function Field({
  label,
  hint,
  children,
  wide = false,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`studio-field ${wide ? "studio-field-wide" : ""}`}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function WorkspaceEditor({
  mode,
  workspaceId,
  onCancel,
  onSaved,
}: WorkspaceEditorProps) {
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const [draft, setDraft] = useState<WorkspaceManifest | null>(
    mode === "create" ? blankWorkspace() : null,
  );
  const [baselineYaml, setBaselineYaml] = useState(
    mode === "create"
      ? stringify(blankWorkspace(), { lineWidth: 0 })
      : "",
  );
  const [section, setSection] = useState<EditorSection>("general");
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localResources, setLocalResources] = useState<LocalResourceOptions>({
    awsProfiles: [],
    kubernetesContexts: [],
    agentConfigurationFiles: [],
  });
  const [resourceDiscoveryError, setResourceDiscoveryError] = useState<
    string | null
  >(null);
  const [directoryInspections, setDirectoryInspections] = useState<
    Record<string, DirectoryInspection>
  >({});
  const [agentConfigurationWarnings, setAgentConfigurationWarnings] = useState<
    Record<string, AgentConfigurationWarning[]>
  >({});
  const [generatedDirectoryIds, setGeneratedDirectoryIds] = useState<Set<string>>(
    () => (mode === "create" ? new Set(["workspace"]) : new Set()),
  );
  const [generatedCloudConnectionIds, setGeneratedCloudConnectionIds] = useState<
    Set<string>
  >(new Set());
  const [generatedKubernetesContextIds, setGeneratedKubernetesContextIds] =
    useState<Set<string>>(new Set());
  const [generatedTargetIds, setGeneratedTargetIds] = useState<Set<string>>(
    () => (mode === "create" ? new Set(["development"]) : new Set()),
  );
  const [generatedAgentProfileIds, setGeneratedAgentProfileIds] = useState<
    Set<string>
  >(() => (mode === "create" ? new Set(["agent"]) : new Set()));

  useEffect(() => {
    if (mode !== "edit" || !workspaceId) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    window.opsCapsule
      .getWorkspace(workspaceId)
      .then((loaded) => {
        if (!cancelled) {
          setDocument(loaded);
          setDraft(structuredClone(loaded.manifest));
          setBaselineYaml(
            stringify(loaded.manifest, { lineWidth: 0 }),
          );
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(describeValidationError(reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    window.opsCapsule
      .discoverLocalResources()
      .then((resources) => {
        if (!cancelled) {
          setLocalResources(resources);
          setResourceDiscoveryError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setResourceDiscoveryError(describeValidationError(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (localResources.awsProfiles.length === 0) {
      return;
    }
    setDraft((current) =>
      current ? attachDiscoveredAwsConfigs(current, localResources) : current,
    );
  }, [document, localResources]);

  const directoryPathKey = draft?.directories
    .map(({ id, path }) => `${id}\0${path}`)
    .join("\u0001") ?? "";
  useEffect(() => {
    let cancelled = false;
    const directories = draft?.directories.filter(({ path }) => path) ?? [];
    void Promise.all(
      directories.map(async ({ id, path }) => {
        try {
          return [id, await window.opsCapsule.inspectDirectory(path)] as const;
        } catch {
          return [id, { path }] as const;
        }
      }),
    ).then((inspections) => {
      if (!cancelled) {
        setDirectoryInspections(Object.fromEntries(inspections));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [directoryPathKey]);

  const agentConfigurationPathKey = draft?.agentProfiles
    .flatMap(({ configuration }) => configuration.files.map(({ source }) => source))
    .filter(Boolean)
    .join("\u0001") ?? "";
  useEffect(() => {
    let cancelled = false;
    const sources = agentConfigurationPathKey
      ? [...new Set(agentConfigurationPathKey.split("\u0001"))]
      : [];
    void Promise.all(
      sources.map(async (source) => {
        try {
          const inspection = await window.opsCapsule.inspectAgentConfiguration(
            source,
            mode === "edit" ? workspaceId : undefined,
          );
          return [source, inspection.warnings] as const;
        } catch {
          return [source, []] as const;
        }
      }),
    ).then((inspections) => {
      if (!cancelled) {
        setAgentConfigurationWarnings(Object.fromEntries(inspections));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [agentConfigurationPathKey, mode, workspaceId]);

  const yaml = useMemo(
    () => (draft ? stringify(draft, { lineWidth: 0 }) : ""),
    [draft],
  );
  const validationError = useMemo(
    () => (draft ? validateDraft(draft) : null),
    [draft],
  );
  const dirty = draft ? yaml !== baselineYaml : false;

  function cancel(): void {
    if (
      !dirty ||
      window.confirm("Discard the unsaved workspace changes?")
    ) {
      onCancel();
    }
  }

  function updateDraft(mutator: (next: WorkspaceManifest) => void): void {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      const next = structuredClone(current);
      mutator(next);
      return next;
    });
    setError(null);
  }

  function renameTrackedResource(
    currentId: string | undefined,
    generatedIds: Set<string>,
    setGeneratedIds: React.Dispatch<React.SetStateAction<Set<string>>>,
    rename: (manifest: WorkspaceManifest, regenerate: boolean) => RenameResult,
  ): void {
    if (!draft || !currentId) {
      return;
    }
    const regenerate = generatedIds.has(currentId);
    const result = rename(structuredClone(draft), regenerate);
    updateDraft((next) => void rename(next, regenerate));
    if (regenerate && result.id !== result.previousId) {
      setGeneratedIds((current) => {
        const next = new Set(current);
        next.delete(result.previousId);
        next.add(result.id);
        return next;
      });
    }
  }

  function renameDirectory(index: number, name: string): void {
    renameTrackedResource(
      draft?.directories[index]?.id,
      generatedDirectoryIds,
      setGeneratedDirectoryIds,
      (manifest, regenerate) =>
        renameDirectoryDraft(manifest, index, name, regenerate),
    );
  }

  function renameCloudConnection(index: number, name: string): void {
    renameTrackedResource(
      draft?.cloudConnections[index]?.id,
      generatedCloudConnectionIds,
      setGeneratedCloudConnectionIds,
      (manifest, regenerate) =>
        renameCloudConnectionDraft(manifest, index, name, regenerate),
    );
  }

  function renameKubernetesContext(index: number, name: string): void {
    renameTrackedResource(
      draft?.kubernetesContexts[index]?.id,
      generatedKubernetesContextIds,
      setGeneratedKubernetesContextIds,
      (manifest, regenerate) =>
        renameKubernetesContextDraft(manifest, index, name, regenerate),
    );
  }

  function renameTarget(index: number, name: string): void {
    renameTrackedResource(
      draft?.targets[index]?.id,
      generatedTargetIds,
      setGeneratedTargetIds,
      (manifest, regenerate) =>
        renameTargetDraft(manifest, index, name, regenerate),
    );
  }

  function renameAgentProfile(index: number, name: string): void {
    renameTrackedResource(
      draft?.agentProfiles[index]?.id,
      generatedAgentProfileIds,
      setGeneratedAgentProfileIds,
      (manifest, regenerate) =>
        renameAgentProfileDraft(manifest, index, name, regenerate),
    );
  }

  async function save(): Promise<void> {
    if (!draft || validationError || saving) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved =
        mode === "create"
          ? await window.opsCapsule.createWorkspace(draft)
          : await window.opsCapsule.saveWorkspace(
              workspaceId ?? draft.metadata.id,
              document?.revision ?? "",
              draft,
            );
      setDocument(saved);
      setDraft(structuredClone(saved.manifest));
      setBaselineYaml(stringify(saved.manifest, { lineWidth: 0 }));
      setGeneratedDirectoryIds(new Set());
      setGeneratedCloudConnectionIds(new Set());
      setGeneratedKubernetesContextIds(new Set());
      setGeneratedTargetIds(new Set());
      setGeneratedAgentProfileIds(new Set());
      await onSaved(saved.manifest.metadata.id);
    } catch (reason) {
      setError(describeValidationError(reason));
    } finally {
      setSaving(false);
    }
  }

  async function browsePath(
    kind: "directory" | "file",
    apply: (path: string) => void,
  ): Promise<void> {
    const selected = await window.opsCapsule.choosePath(kind);
    if (selected) {
      apply(selected);
    }
  }

  if (loading || !draft) {
    return (
      <section className="studio-loading">
        <span className="live-indicator" /> Loading workspace…
      </section>
    );
  }

  return (
    <section className="workspace-studio">
      <header className="studio-header">
        <div>
          <div className="eyebrow">Workspace Studio</div>
          <h1>{mode === "create" ? "Create workspace" : draft.metadata.name}</h1>
          <p>
            {dirty ? "Unsaved changes" : "Saved"} · YAML remains the source of truth
          </p>
        </div>
        <div className="header-actions">
          <button className="secondary-button" onClick={cancel} type="button">
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={
              Boolean(validationError) || saving || (!dirty && mode === "edit")
            }
            onClick={() => void save()}
            type="button"
          >
            {saving ? "Saving…" : mode === "create" ? "Create workspace" : "Save changes"}
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}
      {validationError ? (
        <div className="validation-banner">
          <strong>Needs attention</strong>
          <span>{validationError}</span>
        </div>
      ) : null}

      <div className="studio-layout">
        <nav className="studio-navigation" aria-label="Workspace editor sections">
          {editorSections.map((item) => (
            <button
              className={section === item.id ? "selected" : ""}
              key={item.id}
              onClick={() => setSection(item.id)}
              type="button"
            >
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </nav>

        <div className="studio-form">
          {section === "general" ? (
            <>
              <EditorSectionHeader
                title="Workspace identity"
                description="Names are for people; the stable id is used in manifests and integrations."
              />
              <div className="studio-card studio-fields">
                <Field label="Name">
                  <input
                    value={draft.metadata.name}
                    onChange={(event) =>
                      updateDraft((next) => {
                        next.metadata.name = event.target.value;
                        if (mode === "create") {
                          next.metadata.id = identifierFromName(
                            event.target.value,
                            "workspace",
                          );
                        }
                      })
                    }
                  />
                </Field>
                <Field
                  label="Stable id"
                  hint={
                    mode === "edit"
                      ? "Generated when the workspace was created and now immutable."
                      : "Generated from the workspace name."
                  }
                >
                  <input
                    disabled
                    value={draft.metadata.id}
                  />
                </Field>
                <Field label="Description" wide>
                  <textarea
                    rows={4}
                    value={draft.metadata.description ?? ""}
                    onChange={(event) =>
                      updateDraft((next) => {
                        const value = event.target.value;
                        if (value) {
                          next.metadata.description = value;
                        } else {
                          delete next.metadata.description;
                        }
                      })
                    }
                  />
                </Field>
                {document ? (
                  <Field label="Manifest" wide>
                    <code className="path-value">{document.sourcePath}</code>
                  </Field>
                ) : null}
              </div>
            </>
          ) : null}

          {section === "directories" ? (
            <>
              <EditorSectionHeader
                title="Directories"
                description="Only selected directories are made available to enforced target capsules."
                action={
                  <button
                    className="small-button"
                    onClick={() =>
                      {
                        const id = uniqueIdentifier(
                          "Directory",
                          draft.directories.map((item) => item.id),
                        );
                        setGeneratedDirectoryIds((current) =>
                          new Set(current).add(id),
                        );
                        updateDraft((next) => {
                        next.directories.push({
                          id,
                          name: "Directory",
                          path: "",
                          access: "read-write",
                        });
                        });
                      }
                    }
                    type="button"
                  >
                    + Add directory
                  </button>
                }
              />
              <div className="studio-stack">
                {draft.directories.map((directory, index) => (
                  <article className="studio-card" key={index}>
                    <div className="resource-card-header">
                      <div>
                        <strong>{directory.name || "Untitled directory"}</strong>
                        {directoryInspections[directory.id]?.versionControl ? (
                          <span
                            className="vcs-badge"
                            title={
                              directoryInspections[directory.id]?.versionControl
                                ?.root
                            }
                          >
                            {directoryInspections[
                              directory.id
                            ]?.versionControl?.type.toUpperCase()}
                          </span>
                        ) : null}
                      </div>
                      <button
                        className="text-button danger"
                        disabled={draft.directories.length === 1}
                        onClick={() =>
                          updateDraft((next) => {
                            const removed = next.directories[index]?.id;
                            next.directories.splice(index, 1);
                            for (const target of next.targets) {
                              target.directories = target.directories.filter(
                                (id) => id !== removed,
                              );
                              if (target.defaultDirectory === removed) {
                                target.defaultDirectory = target.directories[0] ?? "";
                              }
                            }
                          })
                        }
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="studio-fields">
                      <Field label="Name">
                        <input
                          value={directory.name}
                          onChange={(event) =>
                            renameDirectory(index, event.target.value)
                          }
                        />
                      </Field>
                      <Field
                        label="Id"
                        hint={
                          generatedDirectoryIds.has(directory.id)
                            ? "Generated from the directory name."
                            : "Stable after the workspace is created."
                        }
                      >
                        <input
                          disabled
                          value={directory.id}
                        />
                      </Field>
                      <Field label="Access">
                        <select
                          value={directory.access}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.directories[index]!.access = event.target.value as
                                | "read-only"
                                | "read-write";
                            })
                          }
                        >
                          <option value="read-write">Read and write</option>
                          <option value="read-only">Read only</option>
                        </select>
                      </Field>
                      <Field label="Path" wide>
                        <div className="path-input">
                          <input
                            value={directory.path}
                            onChange={(event) =>
                              updateDraft((next) => {
                                next.directories[index]!.path = event.target.value;
                              })
                            }
                          />
                          <button
                            className="small-button"
                            onClick={() =>
                              void browsePath("directory", (path) =>
                                updateDraft((next) => {
                                  next.directories[index]!.path = path;
                                }),
                              )
                            }
                            type="button"
                          >
                            Browse…
                          </button>
                        </div>
                      </Field>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : null}

          {section === "cloud" ? (
            <>
              <EditorSectionHeader
                title="Cloud connections"
                description="Select a local profile to copy its non-secret configuration into this workspace. Credentials are never copied."
                action={
                  <button
                    className="small-button"
                    onClick={() => {
                      const name = "AWS account";
                      const id = uniqueIdentifier(
                        name,
                        draft.cloudConnections.map((item) => item.id),
                      );
                      setGeneratedCloudConnectionIds((current) =>
                        new Set(current).add(id),
                      );
                      updateDraft((next) => {
                        next.cloudConnections.push({
                          id,
                          name,
                          provider: "aws",
                          config: {
                            authentication: { type: "profile", profile: "" },
                            expectedIdentity: { accountId: "" },
                            defaults: { region: "" },
                          },
                        });
                      });
                    }}
                    type="button"
                  >
                    + Add connection
                  </button>
                }
              />
              {resourceDiscoveryError ? (
                <div className="resource-discovery-note">
                  Local profiles could not be read: {resourceDiscoveryError}
                </div>
              ) : null}
              {draft.cloudConnections.length === 0 ? (
                <div className="studio-empty">No cloud connections configured.</div>
              ) : null}
              <div className="studio-stack">
                {draft.cloudConnections.map((connection, index) => {
                  const config = awsConfiguration(connection);
                  const selectedProfileIndex = localResources.awsProfiles.findIndex(
                    (profile) =>
                      profile.name === config.authentication.profile &&
                      profile.configFile === config.authentication.configFile,
                  );
                  const updateConfig = (
                    change: (next: AwsConfiguration) => void,
                  ) =>
                    updateDraft((next) => {
                      const item = next.cloudConnections[index]!;
                      const updated = awsConfiguration(item);
                      change(updated);
                      item.config = updated;
                    });
                  return (
                    <article className="studio-card" key={index}>
                      <div className="resource-card-header">
                        <strong>{connection.name || "Untitled connection"}</strong>
                        <button
                          className="text-button danger"
                          onClick={() =>
                            updateDraft((next) => {
                              const removed = next.cloudConnections[index]?.id;
                              next.cloudConnections.splice(index, 1);
                              for (const target of next.targets) {
                                if (target.cloudConnection === removed) {
                                  delete target.cloudConnection;
                                }
                              }
                            })
                          }
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                      <div className="studio-fields">
                        <Field label="Name">
                          <input
                            value={connection.name}
                            onChange={(event) =>
                              renameCloudConnection(index, event.target.value)
                            }
                          />
                        </Field>
                        <Field
                          label="Id"
                          hint={
                            generatedCloudConnectionIds.has(connection.id)
                              ? "Generated from the connection name."
                              : "Stable after the workspace is saved."
                          }
                        >
                          <input
                            disabled
                            value={connection.id}
                          />
                        </Field>
                        <Field label="Provider">
                          <select disabled value={connection.provider}>
                            <option value={connection.provider}>
                              {connection.provider.toUpperCase()}
                            </option>
                          </select>
                        </Field>
                        {connection.provider === "aws" ? (
                          <>
                            <Field
                              label="AWS profile"
                              hint={
                                config.authentication.configFile
                                  ? `Configuration source: ${config.authentication.configFile}`
                                  : "Choose a local profile so OpsCapsule can import its configuration."
                              }
                            >
                              <select
                                value={
                                  selectedProfileIndex >= 0
                                    ? String(selectedProfileIndex)
                                    : config.authentication.profile
                                      ? "current"
                                      : ""
                                }
                                onChange={(event) => {
                                  const profile =
                                    localResources.awsProfiles[
                                      Number(event.target.value)
                                    ];
                                  if (!profile) {
                                    return;
                                  }
                                  updateConfig((next) => {
                                    next.authentication.profile = profile.name;
                                    next.authentication.configFile =
                                      profile.configFile;
                                    if (profile.region) {
                                      next.defaults.region = profile.region;
                                    }
                                    if (profile.accountId) {
                                      next.expectedIdentity.accountId =
                                        profile.accountId;
                                    }
                                  });
                                }}
                              >
                                <option disabled value="">
                                  Select a local AWS profile…
                                </option>
                                {selectedProfileIndex < 0 &&
                                config.authentication.profile ? (
                                  <option value="current">
                                    {config.authentication.profile} (
                                    {config.authentication.configFile
                                      ? "workspace copy"
                                      : "not imported"}
                                    )
                                  </option>
                                ) : null}
                                {localResources.awsProfiles.map((profile, optionIndex) => (
                                  <option
                                    key={`${profile.configFile}:${profile.name}`}
                                    value={optionIndex}
                                  >
                                    {profile.name}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label="Expected account id">
                              <input
                                inputMode="numeric"
                                maxLength={12}
                                placeholder="123456789012"
                                value={config.expectedIdentity.accountId}
                                onChange={(event) =>
                                  updateConfig((next) => {
                                    next.expectedIdentity.accountId = event.target.value;
                                  })
                                }
                              />
                            </Field>
                            <Field label="Default region">
                              <input
                                placeholder="eu-west-1"
                                value={config.defaults.region}
                                onChange={(event) =>
                                  updateConfig((next) => {
                                    next.defaults.region = event.target.value;
                                  })
                                }
                              />
                            </Field>
                          </>
                        ) : (
                          <Field
                            label="Provider configuration"
                            hint="This provider does not have a form editor yet; its configuration is preserved unchanged."
                            wide
                          >
                            <pre className="readonly-json">
                              {JSON.stringify(connection.config, null, 2)}
                            </pre>
                          </Field>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ) : null}

          {section === "kubernetes" ? (
            <>
              <EditorSectionHeader
                title="Kubernetes contexts"
                description="Select a local context to copy only that context and its referenced files into this workspace."
                action={
                  <button
                    className="small-button"
                    onClick={() => {
                      const name = "Kubernetes cluster";
                      const id = uniqueIdentifier(
                        name,
                        draft.kubernetesContexts.map((item) => item.id),
                      );
                      setGeneratedKubernetesContextIds((current) =>
                        new Set(current).add(id),
                      );
                      updateDraft((next) => {
                        next.kubernetesContexts.push({
                          id,
                          name,
                          source: { type: "kubeconfig", path: "", context: "" },
                        });
                      });
                    }}
                    type="button"
                  >
                    + Add context
                  </button>
                }
              />
              {resourceDiscoveryError ? (
                <div className="resource-discovery-note">
                  Local contexts could not be read: {resourceDiscoveryError}
                </div>
              ) : null}
              {draft.kubernetesContexts.length === 0 ? (
                <div className="studio-empty">No Kubernetes contexts configured.</div>
              ) : null}
              <div className="studio-stack">
                {draft.kubernetesContexts.map((context, index) => (
                  <article className="studio-card" key={index}>
                    <div className="resource-card-header">
                      <strong>{context.name || "Untitled context"}</strong>
                      <button
                        className="text-button danger"
                        onClick={() =>
                          updateDraft((next) => {
                            const removed = next.kubernetesContexts[index]?.id;
                            next.kubernetesContexts.splice(index, 1);
                            for (const target of next.targets) {
                              if (target.kubernetesContext === removed) {
                                delete target.kubernetesContext;
                              }
                            }
                          })
                        }
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="studio-fields">
                      <Field label="Name">
                        <input
                          value={context.name}
                          onChange={(event) =>
                            renameKubernetesContext(index, event.target.value)
                          }
                        />
                      </Field>
                      <Field
                        label="Id"
                        hint={
                          generatedKubernetesContextIds.has(context.id)
                            ? "Generated from the context name."
                            : "Stable after the workspace is saved."
                        }
                      >
                        <input
                          disabled
                          value={context.id}
                        />
                      </Field>
                      <Field label="Namespace">
                        <input
                          placeholder="default"
                          value={context.namespace ?? ""}
                          onChange={(event) =>
                            updateDraft((next) => {
                              const value = event.target.value;
                              if (value) {
                                next.kubernetesContexts[index]!.namespace = value;
                              } else {
                                delete next.kubernetesContexts[index]!.namespace;
                              }
                            })
                          }
                        />
                      </Field>
                      <Field label="Source">
                        <select
                          value={context.source.type}
                          onChange={(event) =>
                            updateDraft((next) => {
                              const item = next.kubernetesContexts[index]!;
                              item.source =
                                event.target.value === "generated"
                                  ? { type: "generated", server: "", context: "" }
                                  : { type: "kubeconfig", path: "", context: "" };
                            })
                          }
                        >
                          <option value="kubeconfig">Existing kubeconfig</option>
                          <option value="generated">Generated context</option>
                        </select>
                      </Field>
                      {context.source.type === "kubeconfig" ? (
                        <>
                          <Field
                            label="Local context"
                            hint={`Configuration source: ${context.source.path || "not selected"}`}
                            wide
                          >
                            <select
                              value={
                                localResources.kubernetesContexts.some(
                                  (option) =>
                                    matchesKubernetesOption(
                                      option,
                                      context.source,
                                    ),
                                )
                                  ? JSON.stringify([
                                      context.source.path,
                                      context.source.context,
                                    ])
                                  : context.source.path && context.source.context
                                    ? "current"
                                    : ""
                              }
                              onChange={(event) => {
                                const option =
                                  localResources.kubernetesContexts.find(
                                    (candidate) =>
                                      JSON.stringify([
                                        candidate.path,
                                        candidate.name,
                                      ]) === event.target.value,
                                  );
                                if (!option) {
                                  return;
                                }
                                updateDraft((next) => {
                                  const item = next.kubernetesContexts[index]!;
                                  item.source = {
                                    type: "kubeconfig",
                                    path: option.path,
                                    context: option.name,
                                  };
                                  if (option.namespace) {
                                    item.namespace = option.namespace;
                                  }
                                });
                              }}
                            >
                              <option disabled value="">
                                Select a local Kubernetes context…
                              </option>
                              {context.source.path &&
                              context.source.context &&
                              !localResources.kubernetesContexts.some(
                                (option) =>
                                  matchesKubernetesOption(
                                    option,
                                    context.source,
                                  ),
                              ) ? (
                                <option value="current">
                                  {context.source.context} (workspace copy)
                                </option>
                              ) : null}
                              {localResources.kubernetesContexts.map((option) => (
                                <option
                                  key={`${option.path}:${option.name}`}
                                  value={JSON.stringify([
                                    option.path,
                                    option.name,
                                  ])}
                                >
                                  {option.name}
                                  {option.current ? " · current" : ""}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field
                            label="Other kubeconfig"
                            hint="Fallback for kubeconfig files outside the standard locations."
                            wide
                          >
                            <div className="path-input">
                              <input
                                value={context.source.path}
                                onChange={(event) =>
                                  updateDraft((next) => {
                                    const source =
                                      next.kubernetesContexts[index]!.source;
                                    if (source.type === "kubeconfig") {
                                      source.path = event.target.value;
                                    }
                                  })
                                }
                              />
                              <button
                                className="small-button"
                                onClick={() =>
                                  void browsePath("file", (path) =>
                                    updateDraft((next) => {
                                      const source =
                                        next.kubernetesContexts[index]!.source;
                                      if (source.type === "kubeconfig") {
                                        source.path = path;
                                      }
                                    }),
                                  )
                                }
                                type="button"
                              >
                                Browse…
                              </button>
                            </div>
                          </Field>
                        </>
                      ) : (
                        <Field label="API server" wide>
                          <input
                            placeholder="https://cluster.example.com"
                            value={context.source.server}
                            onChange={(event) =>
                              updateDraft((next) => {
                                const source = next.kubernetesContexts[index]!.source;
                                if (source.type === "generated") {
                                  source.server = event.target.value;
                                }
                              })
                            }
                          />
                        </Field>
                      )}
                      <Field label="Context name" wide>
                        <input
                          value={context.source.context}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.kubernetesContexts[index]!.source.context =
                                event.target.value;
                            })
                          }
                        />
                      </Field>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : null}

          {section === "agents" ? (
            <>
              <EditorSectionHeader
                title="Agent profiles"
                description="Configure how the Agent pane starts without exposing your real home directory."
                action={
                  <button
                    className="small-button"
                    onClick={() => {
                      const name = "Agent profile";
                      const id = uniqueIdentifier(
                        name,
                        draft.agentProfiles.map((item) => item.id),
                      );
                      setGeneratedAgentProfileIds((current) =>
                        new Set(current).add(id),
                      );
                      updateDraft((next) => {
                        next.agentProfiles.push({
                          id,
                          name,
                          adapter: "command",
                          runtime: { command: "$SHELL", args: [] },
                          configuration: { files: [] },
                          environment: {},
                        });
                        if (
                          !next.defaultAgentProfile &&
                          next.targets.every((target) => !target.agentRuntime)
                        ) {
                          next.defaultAgentProfile = id;
                        }
                      });
                    }}
                    type="button"
                  >
                    + Add profile
                  </button>
                }
              />
              {resourceDiscoveryError ? (
                <p className="resource-discovery-note">
                  Local agent settings could not be read: {resourceDiscoveryError}
                </p>
              ) : null}
              <div className="studio-stack">
                <div className="studio-card studio-fields">
                  <Field
                    label="Portable workspace instructions"
                    hint="Applied to every target. OpenCode receives AGENTS.md, Claude Code receives CLAUDE.md, and custom commands receive OPSCAPSULE_AGENT_INSTRUCTIONS. Do not put secrets here."
                    wide
                  >
                    <textarea
                      placeholder="Describe the workspace, operating conventions, safe verification steps, and escalation rules…"
                      rows={8}
                      value={draft.agentInstructions ?? ""}
                      onChange={(event) =>
                        updateDraft((next) => {
                          const value = event.target.value;
                          if (value) {
                            next.agentInstructions = value;
                          } else {
                            delete next.agentInstructions;
                          }
                        })
                      }
                    />
                  </Field>
                </div>
                <div className="studio-card studio-fields">
                  <Field
                    label="Workspace default"
                    hint="Targets inherit this profile unless they select an override."
                    wide
                  >
                    <select
                      value={draft.defaultAgentProfile ?? ""}
                      onChange={(event) =>
                        updateDraft((next) => {
                          const value = event.target.value;
                          if (value) {
                            next.defaultAgentProfile = value;
                            for (const target of next.targets) {
                              if (!target.agentProfile) {
                                delete target.agentRuntime;
                              }
                            }
                          } else {
                            delete next.defaultAgentProfile;
                          }
                        })
                      }
                    >
                      <option value="">No workspace default</option>
                      {draft.agentProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                {draft.agentProfiles.map((profile, index) => {
                  const discoveredFiles =
                    localResources.agentConfigurationFiles.filter(
                      ({ adapter }) => adapter === profile.adapter,
                    );
                  const openCodeDestinations = [
                    ".config/opencode/opencode.json",
                    ".config/opencode/tui.json",
                  ];
                  const claudeCodeDestinations = [".claude/settings.json"];
                  const adapterDestinations = profile.adapter === "opencode"
                    ? openCodeDestinations
                    : profile.adapter === "claude-code"
                      ? claudeCodeDestinations
                      : [];
                  return (
                    <article className="studio-card" key={index}>
                      <div className="resource-card-header">
                        <div>
                          <strong>{profile.name || "Untitled profile"}</strong>
                          <span className="vcs-badge">{profile.adapter}</span>
                          {draft.defaultAgentProfile === profile.id ? (
                            <span className="vcs-badge">default</span>
                          ) : null}
                        </div>
                        <button
                          className="text-button danger"
                          onClick={() =>
                            updateDraft((next) => {
                              const removed = next.agentProfiles[index]?.id;
                              next.agentProfiles.splice(index, 1);
                              if (next.defaultAgentProfile === removed) {
                                const replacement = next.agentProfiles[0]?.id;
                                if (replacement) {
                                  next.defaultAgentProfile = replacement;
                                } else {
                                  delete next.defaultAgentProfile;
                                }
                              }
                              for (const target of next.targets) {
                                if (target.agentProfile === removed) {
                                  delete target.agentProfile;
                                }
                              }
                            })
                          }
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                      <div className="studio-fields">
                        <Field label="Name">
                          <input
                            value={profile.name}
                            onChange={(event) =>
                              renameAgentProfile(index, event.target.value)
                            }
                          />
                        </Field>
                        <Field
                          label="Id"
                          hint={
                            generatedAgentProfileIds.has(profile.id)
                              ? "Generated from the profile name."
                              : "Stable after the workspace is saved."
                          }
                        >
                          <input disabled value={profile.id} />
                        </Field>
                        <Field label="Adapter">
                          <select
                            value={profile.adapter}
                            onChange={(event) =>
                              updateDraft((next) => {
                                const item = next.agentProfiles[index]!;
                                item.adapter = event.target.value;
                                item.configuration.files = [];
                                if (
                                  item.adapter === "opencode" &&
                                  item.runtime.command === "$SHELL"
                                ) {
                                  item.runtime.command = "opencode";
                                }
                                if (
                                  item.adapter === "claude-code" &&
                                  ["$SHELL", "opencode"].includes(item.runtime.command)
                                ) {
                                  item.runtime.command = "claude";
                                }
                              })
                            }
                          >
                            <option value="command">Custom command</option>
                            <option value="opencode">OpenCode</option>
                            <option value="claude-code">Claude Code</option>
                            {!["command", "opencode", "claude-code"].includes(profile.adapter) ? (
                              <option value={profile.adapter}>{profile.adapter}</option>
                            ) : null}
                          </select>
                        </Field>
                        <Field label="Command">
                          <input
                            value={profile.runtime.command}
                            onChange={(event) =>
                              updateDraft((next) => {
                                next.agentProfiles[index]!.runtime.command =
                                  event.target.value;
                              })
                            }
                          />
                        </Field>
                        <Field label="Arguments" wide hint="One literal argument per line.">
                          <textarea
                            rows={3}
                            value={profile.runtime.args.join("\n")}
                            onChange={(event) =>
                              updateDraft((next) => {
                                next.agentProfiles[index]!.runtime.args =
                                  event.target.value
                                    .split("\n")
                                    .filter((value) => value.length > 0);
                              })
                            }
                          />
                        </Field>
                        <Field
                          label="Environment"
                          wide
                          hint="One NAME=value per line. Values are stored as plaintext; do not enter secrets."
                        >
                          <textarea
                            rows={4}
                            value={environmentText(profile.environment)}
                            onChange={(event) =>
                              updateDraft((next) => {
                                next.agentProfiles[index]!.environment =
                                  parseEnvironmentText(event.target.value);
                              })
                            }
                          />
                        </Field>

                        {discoveredFiles.length > 0 ? (
                          <Field
                            label="Discovered configuration"
                            hint="Selected files are copied into this workspace when you save."
                            wide
                          >
                            <div className="choice-grid">
                              {discoveredFiles.map((option) => {
                                const checked = profile.configuration.files.some(
                                  ({ destination }) =>
                                    destination === option.destination,
                                );
                                return (
                                  <label key={option.destination}>
                                    <input
                                      checked={checked}
                                      onChange={(event) =>
                                        updateDraft((next) => {
                                          const files =
                                            next.agentProfiles[index]!.configuration.files;
                                          const filtered = files.filter(
                                            ({ destination }) =>
                                              destination !== option.destination,
                                          );
                                          next.agentProfiles[index]!.configuration.files =
                                            event.target.checked
                                              ? [
                                                  ...filtered,
                                                  {
                                                    source: option.path,
                                                    destination: option.destination,
                                                  },
                                                ]
                                              : filtered;
                                        })
                                      }
                                      type="checkbox"
                                    />
                                    <span>{option.name}</span>
                                    <small>
                                      {option.warnings.length > 0
                                        ? `review ${option.warnings.map(({ category }) => category).join(", ")}`
                                        : "managed"}
                                    </small>
                                  </label>
                                );
                              })}
                            </div>
                          </Field>
                        ) : null}

                        <div className="studio-field studio-field-wide">
                          <span>Managed configuration files</span>
                          <div className="configuration-files">
                            {profile.configuration.files.map((file, fileIndex) => (
                              <div className="configuration-file" key={fileIndex}>
                                <div className="path-input">
                                  <input
                                    aria-label="Configuration source"
                                    value={file.source}
                                    onChange={(event) =>
                                      updateDraft((next) => {
                                        next.agentProfiles[index]!.configuration.files[
                                          fileIndex
                                        ]!.source = event.target.value;
                                      })
                                    }
                                  />
                                  <button
                                    className="small-button"
                                    onClick={() =>
                                      void browsePath("file", (path) =>
                                        updateDraft((next) => {
                                          next.agentProfiles[
                                            index
                                          ]!.configuration.files[fileIndex]!.source = path;
                                        }),
                                      )
                                    }
                                    type="button"
                                  >
                                    Browse…
                                  </button>
                                </div>
                                {adapterDestinations.length > 0 ? (
                                  <select
                                    aria-label="Configuration destination"
                                    value={file.destination}
                                    onChange={(event) =>
                                      updateDraft((next) => {
                                        next.agentProfiles[index]!.configuration.files[
                                          fileIndex
                                        ]!.destination = event.target.value;
                                      })
                                    }
                                  >
                                    {adapterDestinations.map((destination) => (
                                      <option key={destination} value={destination}>
                                        {destination}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    aria-label="Configuration destination"
                                    placeholder=".config/agent/config.json"
                                    value={file.destination}
                                    onChange={(event) =>
                                      updateDraft((next) => {
                                        next.agentProfiles[index]!.configuration.files[
                                          fileIndex
                                        ]!.destination = event.target.value;
                                      })
                                    }
                                  />
                                )}
                                <button
                                  className="text-button danger"
                                  onClick={() =>
                                    updateDraft((next) => {
                                      next.agentProfiles[
                                        index
                                      ]!.configuration.files.splice(fileIndex, 1);
                                    })
                                  }
                                  type="button"
                                >
                                  Remove file
                                </button>
                                {(agentConfigurationWarnings[file.source] ?? []).map(
                                  (warning) => (
                                    <div
                                      className={`configuration-file-warning ${warning.severity}`}
                                      key={warning.category}
                                    >
                                      <strong>{warning.category}</strong>
                                      <span>{warning.message}</span>
                                    </div>
                                  ),
                                )}
                              </div>
                            ))}
                            <button
                              className="small-button"
                              disabled={
                                adapterDestinations.length > 0 &&
                                adapterDestinations.every((destination) =>
                                  profile.configuration.files.some(
                                    (file) => file.destination === destination,
                                  ),
                                )
                              }
                              onClick={() =>
                                updateDraft((next) => {
                                  const item = next.agentProfiles[index]!;
                                  const destination =
                                    adapterDestinations.length > 0
                                      ? adapterDestinations.find(
                                          (candidate) =>
                                            !item.configuration.files.some(
                                              (file) =>
                                                file.destination === candidate,
                                            ),
                                        ) ?? adapterDestinations[0]!
                                      : ".config/agent/config.json";
                                  item.configuration.files.push({
                                    source: "",
                                    destination,
                                  });
                                })
                              }
                              type="button"
                            >
                              + Add configuration file
                            </button>
                          </div>
                          <small>
                            Configuration can contain hooks or tool declarations.
                            Review imported files; credentials and history are not
                            imported automatically.
                          </small>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ) : null}

          {section === "targets" ? (
            <>
              <EditorSectionHeader
                title="Targets"
                description="A target binds resources into one operational environment."
                action={
                  <button
                    className="small-button"
                    onClick={() => {
                      const name = "Target";
                      const id = uniqueIdentifier(
                        name,
                        draft.targets.map((item) => item.id),
                      );
                      const firstDirectory = draft.directories[0]?.id ?? "";
                      setGeneratedTargetIds((current) =>
                        new Set(current).add(id),
                      );
                      updateDraft((next) => {
                        next.targets.push({
                          id,
                          name,
                          environment: id,
                          risk: "development",
                          directories: firstDirectory ? [firstDirectory] : [],
                          defaultDirectory: firstDirectory,
                          ...(draft.defaultAgentProfile
                            ? {}
                            : draft.agentProfiles[0]
                              ? { agentProfile: draft.agentProfiles[0].id }
                              : {
                                  agentRuntime: {
                                    adapter: "command" as const,
                                    command: "$SHELL",
                                    args: [],
                                  },
                                }),
                          isolation: {
                            mode: "enforced",
                            network: { mode: "public", allowedDomains: [] },
                          },
                        });
                      });
                    }}
                    type="button"
                  >
                    + Add target
                  </button>
                }
              />
              <div className="studio-stack">
                {draft.targets.map((target, index) => (
                  <article
                    className={`studio-card target-editor-card risk-border-${target.risk}`}
                    key={index}
                  >
                    <div className="resource-card-header">
                      <div>
                        <strong>{target.name || "Untitled target"}</strong>
                        <span className={`risk-badge risk-${target.risk}`}>
                          {target.risk}
                        </span>
                      </div>
                      <button
                        className="text-button danger"
                        disabled={draft.targets.length === 1}
                        onClick={() =>
                          updateDraft((next) => {
                            next.targets.splice(index, 1);
                          })
                        }
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="studio-fields">
                      <Field label="Name">
                        <input
                          value={target.name}
                          onChange={(event) =>
                            renameTarget(index, event.target.value)
                          }
                        />
                      </Field>
                      <Field
                        label="Id"
                        hint={
                          generatedTargetIds.has(target.id)
                            ? "Generated from the target name."
                            : "Stable after the workspace is saved."
                        }
                      >
                        <input
                          disabled
                          value={target.id}
                        />
                      </Field>
                      <Field label="Environment">
                        <input
                          value={target.environment}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.targets[index]!.environment = event.target.value;
                            })
                          }
                        />
                      </Field>
                      <Field label="Risk">
                        <select
                          value={target.risk}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.targets[index]!.risk = event.target.value as
                                | "development"
                                | "staging"
                                | "production";
                            })
                          }
                        >
                          <option value="development">Development</option>
                          <option value="staging">Staging</option>
                          <option value="production">Production</option>
                        </select>
                      </Field>
                      <Field label="Cloud connection">
                        <select
                          value={target.cloudConnection ?? ""}
                          onChange={(event) =>
                            updateDraft((next) => {
                              const value = event.target.value;
                              if (value) {
                                next.targets[index]!.cloudConnection = value;
                              } else {
                                delete next.targets[index]!.cloudConnection;
                              }
                            })
                          }
                        >
                          <option value="">None</option>
                          {draft.cloudConnections.map((connection) => (
                            <option key={connection.id} value={connection.id}>
                              {connection.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Kubernetes context">
                        <select
                          value={target.kubernetesContext ?? ""}
                          onChange={(event) =>
                            updateDraft((next) => {
                              const value = event.target.value;
                              if (value) {
                                next.targets[index]!.kubernetesContext = value;
                              } else {
                                delete next.targets[index]!.kubernetesContext;
                              }
                            })
                          }
                        >
                          <option value="">None</option>
                          {draft.kubernetesContexts.map((context) => (
                            <option key={context.id} value={context.id}>
                              {context.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Directories" wide>
                        <div className="choice-grid">
                          {draft.directories.map((directory) => (
                            <label key={directory.id}>
                              <input
                                checked={target.directories.includes(directory.id)}
                                onChange={(event) =>
                                  updateDraft((next) => {
                                    const item = next.targets[index]!;
                                    item.directories = event.target.checked
                                      ? [...item.directories, directory.id]
                                      : item.directories.filter(
                                          (id) => id !== directory.id,
                                        );
                                    if (!item.directories.includes(item.defaultDirectory)) {
                                      item.defaultDirectory = item.directories[0] ?? "";
                                    }
                                  })
                                }
                                type="checkbox"
                              />
                              <span>{directory.name}</span>
                              <small>{directory.access === "read-write" ? "RW" : "RO"}</small>
                            </label>
                          ))}
                        </div>
                      </Field>
                      <Field label="Default directory">
                        <select
                          value={target.defaultDirectory}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.targets[index]!.defaultDirectory = event.target.value;
                            })
                          }
                        >
                          {target.directories.map((directoryId) => (
                            <option key={directoryId} value={directoryId}>
                              {draft.directories.find(({ id }) => id === directoryId)?.name ?? directoryId}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        label="Agent profile"
                        hint="Leave inherited to use the workspace default."
                      >
                        <select
                          value={target.agentProfile ?? ""}
                          onChange={(event) =>
                            updateDraft((next) => {
                              const item = next.targets[index]!;
                              const value = event.target.value;
                              if (value) {
                                item.agentProfile = value;
                                delete item.agentRuntime;
                              } else {
                                delete item.agentProfile;
                              }
                            })
                          }
                        >
                          <option value="">
                            {target.agentRuntime && !draft.defaultAgentProfile
                              ? "Legacy target command"
                              : draft.defaultAgentProfile
                                ? `Inherit: ${
                                    draft.agentProfiles.find(
                                      ({ id }) =>
                                        id === draft.defaultAgentProfile,
                                    )?.name ?? draft.defaultAgentProfile
                                  }`
                                : "No workspace default"}
                          </option>
                          {draft.agentProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      {target.agentRuntime &&
                      !target.agentProfile &&
                      !draft.defaultAgentProfile ? (
                        <>
                          <Field label="Legacy agent command">
                            <input
                              value={target.agentRuntime.command}
                              onChange={(event) =>
                                updateDraft((next) => {
                                  next.targets[index]!.agentRuntime!.command =
                                    event.target.value;
                                })
                              }
                            />
                          </Field>
                          <Field
                            label="Legacy agent arguments"
                            wide
                            hint="Create an agent profile to replace this compatibility runtime."
                          >
                            <textarea
                              rows={3}
                              value={target.agentRuntime.args.join("\n")}
                              onChange={(event) =>
                                updateDraft((next) => {
                                  next.targets[index]!.agentRuntime!.args =
                                    event.target.value
                                      .split("\n")
                                      .filter((value) => value.length > 0);
                                })
                              }
                            />
                          </Field>
                        </>
                      ) : null}
                      <Field label="Isolation">
                        <select
                          value={target.isolation.mode}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.targets[index]!.isolation.mode = event.target.value as
                                | "enforced"
                                | "context-only";
                            })
                          }
                        >
                          <option value="enforced">Enforced</option>
                          <option value="context-only">Context only</option>
                        </select>
                      </Field>
                      <Field label="Network">
                        <select
                          value={target.isolation.network.mode}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.targets[index]!.isolation.network.mode = event.target.value as
                                | "public"
                                | "deny"
                                | "allowlist";
                            })
                          }
                        >
                          <option value="public">Public destinations</option>
                          <option value="deny">Deny network</option>
                          <option value="allowlist">Allowlist</option>
                        </select>
                      </Field>
                      {target.isolation.network.mode === "allowlist" ? (
                        <Field label="Allowed domains" wide hint="One domain or wildcard per line.">
                          <textarea
                            rows={4}
                            value={target.isolation.network.allowedDomains.join("\n")}
                            onChange={(event) =>
                              updateDraft((next) => {
                                next.targets[index]!.isolation.network.allowedDomains =
                                  event.target.value
                                    .split("\n")
                                    .map((value) => value.trim())
                                    .filter(Boolean);
                              })
                            }
                          />
                        </Field>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : null}
        </div>

        <aside className="yaml-preview">
          <header>
            <div>
              <strong>YAML preview</strong>
              <span>{validationError ? "Invalid draft" : "Valid manifest"}</span>
            </div>
            <span className={`validation-dot ${validationError ? "invalid" : "valid"}`} />
          </header>
          <pre>{yaml}</pre>
        </aside>
      </div>
    </section>
  );
}

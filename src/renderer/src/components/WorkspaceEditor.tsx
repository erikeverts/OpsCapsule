import { useEffect, useMemo, useState } from "react";
import { stringify } from "yaml";
import { ZodError } from "zod";
import type {
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

type EditorSection =
  | "general"
  | "directories"
  | "cloud"
  | "kubernetes"
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
        agentRuntime: { adapter: "command", command: "$SHELL", args: [] },
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
  });
  const [resourceDiscoveryError, setResourceDiscoveryError] = useState<
    string | null
  >(null);
  const [directoryInspections, setDirectoryInspections] = useState<
    Record<string, DirectoryInspection>
  >({});
  const [generatedDirectoryIds, setGeneratedDirectoryIds] = useState<Set<string>>(
    () => (mode === "create" ? new Set(["workspace"]) : new Set()),
  );

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

  function renameDirectory(index: number, name: string): void {
    const directory = draft?.directories[index];
    if (!directory) {
      return;
    }
    const previous = directory.id;
    const generated = generatedDirectoryIds.has(previous);
    const id = generated
      ? uniqueIdentifier(
          name,
          draft.directories
            .filter((_, itemIndex) => itemIndex !== index)
            .map((item) => item.id),
        )
      : previous;
    updateDraft((next) => {
      const item = next.directories[index]!;
      item.name = name;
      item.id = id;
      if (id !== previous) {
        for (const target of next.targets) {
          target.directories = target.directories.map((directoryId) =>
            directoryId === previous ? id : directoryId,
          );
          if (target.defaultDirectory === previous) {
            target.defaultDirectory = id;
          }
        }
      }
    });
    if (generated && id !== previous) {
      setGeneratedDirectoryIds((current) => {
        const next = new Set(current);
        next.delete(previous);
        next.add(id);
        return next;
      });
    }
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
                    onClick={() =>
                      updateDraft((next) => {
                        const id = uniqueIdentifier(
                          "aws",
                          next.cloudConnections.map((item) => item.id),
                        );
                        next.cloudConnections.push({
                          id,
                          name: "AWS account",
                          provider: "aws",
                          config: {
                            authentication: { type: "profile", profile: "" },
                            expectedIdentity: { accountId: "" },
                            defaults: { region: "" },
                          },
                        });
                      })
                    }
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
                              updateDraft((next) => {
                                next.cloudConnections[index]!.name = event.target.value;
                              })
                            }
                          />
                        </Field>
                        <Field label="Id">
                          <input
                            value={connection.id}
                            onChange={(event) =>
                              updateDraft((next) => {
                                const item = next.cloudConnections[index]!;
                                const previous = item.id;
                                item.id = event.target.value;
                                for (const target of next.targets) {
                                  if (target.cloudConnection === previous) {
                                    target.cloudConnection = item.id;
                                  }
                                }
                              })
                            }
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
                    onClick={() =>
                      updateDraft((next) => {
                        const id = uniqueIdentifier(
                          "cluster",
                          next.kubernetesContexts.map((item) => item.id),
                        );
                        next.kubernetesContexts.push({
                          id,
                          name: "Kubernetes cluster",
                          source: { type: "kubeconfig", path: "", context: "" },
                        });
                      })
                    }
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
                            updateDraft((next) => {
                              next.kubernetesContexts[index]!.name = event.target.value;
                            })
                          }
                        />
                      </Field>
                      <Field label="Id">
                        <input
                          value={context.id}
                          onChange={(event) =>
                            updateDraft((next) => {
                              const item = next.kubernetesContexts[index]!;
                              const previous = item.id;
                              item.id = event.target.value;
                              for (const target of next.targets) {
                                if (target.kubernetesContext === previous) {
                                  target.kubernetesContext = item.id;
                                }
                              }
                            })
                          }
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

          {section === "targets" ? (
            <>
              <EditorSectionHeader
                title="Targets"
                description="A target binds resources into one operational environment."
                action={
                  <button
                    className="small-button"
                    onClick={() =>
                      updateDraft((next) => {
                        const id = uniqueIdentifier(
                          "target",
                          next.targets.map((item) => item.id),
                        );
                        const firstDirectory = next.directories[0]?.id ?? "";
                        next.targets.push({
                          id,
                          name: "Target",
                          environment: id,
                          risk: "development",
                          directories: firstDirectory ? [firstDirectory] : [],
                          defaultDirectory: firstDirectory,
                          agentRuntime: {
                            adapter: "command",
                            command: "$SHELL",
                            args: [],
                          },
                          isolation: {
                            mode: "enforced",
                            network: { mode: "public", allowedDomains: [] },
                          },
                        });
                      })
                    }
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
                            updateDraft((next) => {
                              next.targets[index]!.name = event.target.value;
                            })
                          }
                        />
                      </Field>
                      <Field label="Id">
                        <input
                          value={target.id}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.targets[index]!.id = event.target.value;
                            })
                          }
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
                      <Field label="Agent command">
                        <input
                          value={target.agentRuntime.command}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.targets[index]!.agentRuntime.command = event.target.value;
                            })
                          }
                        />
                      </Field>
                      <Field label="Agent arguments" wide hint="One argument per line.">
                        <textarea
                          rows={3}
                          value={target.agentRuntime.args.join("\n")}
                          onChange={(event) =>
                            updateDraft((next) => {
                              next.targets[index]!.agentRuntime.args = event.target.value
                                .split("\n")
                                .filter((value) => value.length > 0);
                            })
                          }
                        />
                      </Field>
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

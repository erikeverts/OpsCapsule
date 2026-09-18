import { useEffect, useMemo, useState } from "react";
import type {
  WorkspaceCatalog,
  WorkspaceCatalogEntry,
  WorkspaceSession,
  WorkspaceTargetSummary,
  TargetReadinessReport,
} from "../../shared/contracts";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceEditor } from "./components/WorkspaceEditor";

type EditorRoute =
  | { mode: "create" }
  | { mode: "edit"; workspaceId: string };

function sessionKey(workspaceId: string, targetId: string): string {
  return `${workspaceId}/${targetId}`;
}

function CapsuleView({
  session,
  active,
}: {
  session: WorkspaceSession;
  active: boolean;
}) {
  return (
    <section className="capsule-view" hidden={!active}>
      <div className="terminal-grid">
        {session.terminals.map((terminal, index) => (
          <article
            className={`terminal-card terminal-card-${index + 1}`}
            key={terminal.id}
          >
            <div className="terminal-titlebar">
              <div className="terminal-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <span>{terminal.title}</span>
              <span className="terminal-kind">{terminal.kind}</span>
            </div>
            <TerminalPane
              sessionId={session.id}
              terminal={terminal}
              active={active}
            />
          </article>
        ))}
      </div>
    </section>
  );
}

function ContextStrip({ target }: { target: WorkspaceTargetSummary }) {
  return (
    <section className="context-strip" aria-label="Target context">
      <div>
        <span>Cloud</span>
        <strong>
          {target.cloud
            ? `${target.cloud.provider.toUpperCase()} · ${target.cloud.name}`
            : "None"}
        </strong>
      </div>
      <div>
        <span>Identity</span>
        <strong>{target.cloud?.identity ?? "Not configured"}</strong>
      </div>
      <div>
        <span>Kubernetes</span>
        <strong>{target.kubernetes?.context ?? "Isolated empty config"}</strong>
      </div>
      <div>
        <span>Agent</span>
        <strong>
          {target.agent.name} · {target.agent.adapter}
        </strong>
      </div>
      <div
        aria-describedby="filesystem-root-details"
        className="context-filesystem"
        tabIndex={0}
      >
        <span>Filesystem</span>
        <strong>
          {target.isolationMode === "enforced"
            ? `${target.directories.length} roots enforced`
            : "Context only"}
        </strong>
        <div
          className="context-tooltip"
          id="filesystem-root-details"
          role="tooltip"
        >
          <span className="context-tooltip-title">Configured roots</span>
          {target.directories.map((directory) => (
            <div className="context-tooltip-root" key={directory.id}>
              <div>
                <strong>{directory.name}</strong>
                <span>
                  {directory.access === "read-write" ? "Read/write" : "Read only"}
                </span>
              </div>
              <code>{directory.path}</code>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkspaceNavigation({
  workspaces,
  selectedId,
  sessions,
  disabled,
  onSelect,
}: {
  workspaces: WorkspaceCatalogEntry[];
  selectedId: string;
  sessions: Record<string, WorkspaceSession>;
  disabled: boolean;
  onSelect: (workspace: WorkspaceCatalogEntry) => void;
}) {
  return (
    <nav className="workspace-list" aria-label="Workspaces">
      {workspaces.map((workspace) => {
        const running = Object.values(sessions).some(
          (session) => session.workspace.id === workspace.id,
        );
        return (
          <button
            className={workspace.id === selectedId ? "selected" : ""}
            disabled={disabled}
            key={workspace.id}
            onClick={() => onSelect(workspace)}
            type="button"
          >
            <span className={`status-dot ${running ? "running" : ""}`} />
            <span>
              <strong>{workspace.name}</strong>
              <small>
                {workspace.targets.length} target
                {workspace.targets.length === 1 ? "" : "s"}
              </small>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export function App() {
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [sessions, setSessions] = useState<Record<string, WorkspaceSession>>({});
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorRoute | null>(null);
  const [readiness, setReadiness] = useState<TargetReadinessReport | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);

  useEffect(() => {
    window.opsCapsule
      .listWorkspaces()
      .then((loadedCatalog) => {
        setCatalog(loadedCatalog);
        const workspace = loadedCatalog.workspaces[0];
        setSelectedWorkspaceId(workspace?.id ?? "");
        setSelectedTargetId(workspace?.targets[0]?.id ?? "");
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  const selectedWorkspace = useMemo(
    () =>
      catalog?.workspaces.find(({ id }) => id === selectedWorkspaceId),
    [catalog, selectedWorkspaceId],
  );
  const selectedTarget = useMemo(
    () =>
      selectedWorkspace?.targets.find(({ id }) => id === selectedTargetId),
    [selectedTargetId, selectedWorkspace],
  );
  const activeKey =
    selectedWorkspace && selectedTarget
      ? sessionKey(selectedWorkspace.id, selectedTarget.id)
      : "";
  const selectedSession = sessions[activeKey];

  useEffect(() => {
    if (!selectedWorkspace || !selectedTarget) {
      setReadiness(null);
      return;
    }
    let cancelled = false;
    setReadiness(null);
    setReadinessError(null);
    window.opsCapsule
      .checkTargetReadiness(selectedWorkspace.id, selectedTarget.id)
      .then((report) => {
        if (!cancelled) {
          setReadiness(report);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setReadinessError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTarget, selectedWorkspace]);

  function selectWorkspace(workspace: WorkspaceCatalogEntry): void {
    if (workspace.id === selectedWorkspaceId) {
      return;
    }
    setSelectedWorkspaceId(workspace.id);
    setSelectedTargetId(workspace.targets[0]?.id ?? "");
    setError(null);
  }

  async function workspaceSaved(workspaceId: string): Promise<void> {
    const loadedCatalog = await window.opsCapsule.listWorkspaces();
    setCatalog(loadedCatalog);
    const workspace = loadedCatalog.workspaces.find(
      ({ id }) => id === workspaceId,
    );
    setSelectedWorkspaceId(workspaceId);
    setSelectedTargetId(workspace?.targets[0]?.id ?? "");
    setEditor(null);
    setError(null);
  }

  async function workspaceDeleted(workspaceId: string): Promise<void> {
    const loadedCatalog = await window.opsCapsule.listWorkspaces();
    const nextWorkspace = loadedCatalog.workspaces.find(
      ({ id }) => id !== workspaceId,
    );
    setCatalog(loadedCatalog);
    setSelectedWorkspaceId(nextWorkspace?.id ?? "");
    setSelectedTargetId(nextWorkspace?.targets[0]?.id ?? "");
    setReadiness(null);
    setEditor(null);
    setError(null);
  }

  async function startWorkspace(
    workspaceId: string,
    targetId: string,
  ): Promise<void> {
    const key = sessionKey(workspaceId, targetId);
    if (sessions[key] || startingKey) {
      return;
    }
    setStartingKey(key);
    setError(null);
    try {
      const session = await window.opsCapsule.startWorkspace(
        workspaceId,
        targetId,
      );
      setSessions((current) => ({ ...current, [key]: session }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStartingKey(null);
    }
  }

  async function stopWorkspace(key: string): Promise<void> {
    const session = sessions[key];
    if (!session) {
      return;
    }
    await window.opsCapsule.stopWorkspace(session.id);
    setSessions((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  const production = selectedTarget?.risk === "production";
  const selectedWorkspaceRunning = selectedWorkspace
    ? Object.values(sessions).some(
        (session) => session.workspace.id === selectedWorkspace.id,
      )
    : false;

  return (
    <main
      className={`app-shell ${production && !editor ? "production-active" : ""}`}
    >
      <div className="window-drag-region" aria-hidden="true" />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img alt="" src="./opscapsule-mark.svg" />
          </div>
          <div>
            <strong>OpsCapsule</strong>
            <span>Context, contained.</span>
          </div>
        </div>

        <p className="section-label">Workspaces</p>
        <WorkspaceNavigation
          workspaces={catalog?.workspaces ?? []}
          selectedId={selectedWorkspaceId}
          sessions={sessions}
          disabled={editor !== null}
          onSelect={selectWorkspace}
        />

        <button
          className="sidebar-create-button"
          disabled={editor !== null}
          onClick={() => setEditor({ mode: "create" })}
          type="button"
        >
          <span>+</span> New workspace
        </button>

        <div className="sidebar-note">
          <span className="shield">◇</span>
          <div>
            <strong>
              {editor
                ? "Editing configuration"
                : selectedTarget?.isolationMode === "enforced"
                ? "Filesystem enforced"
                : "Context isolation only"}
            </strong>
            <span>
              {editor
                ? "Changes are validated and written back to the workspace YAML manifest."
                : selectedTarget?.isolationMode === "enforced"
                ? "Configured roots and capsule-private storage are enforced by the OS."
                : "Filesystem access is not restricted for this target."}
            </span>
          </div>
        </div>
      </aside>

      <div className={`workspace-area ${editor ? "studio-active" : ""}`}>
        {editor ? (
          <WorkspaceEditor
            mode={editor.mode}
            onCancel={() => setEditor(null)}
            onDeleted={workspaceDeleted}
            onSaved={workspaceSaved}
            workspaceId={editor.mode === "edit" ? editor.workspaceId : undefined}
          />
        ) : selectedWorkspace && selectedTarget ? (
          <>
            <header className="workspace-header">
              <div>
                <div className="eyebrow">
                  <span className="live-indicator" />
                  {selectedSession ? "Capsule running" : "Capsule ready"}
                </div>
                <h1>
                  {selectedWorkspace.name}
                  <span className={`risk-badge risk-${selectedTarget.risk}`}>
                    {selectedTarget.risk}
                  </span>
                </h1>
              </div>
              <div className="header-actions">
                <button
                  className="secondary-button"
                  disabled={selectedWorkspaceRunning}
                  onClick={() =>
                    setEditor({
                      mode: "edit",
                      workspaceId: selectedWorkspace.id,
                    })
                  }
                  title={
                    selectedWorkspaceRunning
                      ? "Stop this workspace before editing it"
                      : undefined
                  }
                  type="button"
                >
                  Edit workspace
                </button>
                {selectedSession ? (
                  <button
                    className="secondary-button"
                    onClick={() => void stopWorkspace(activeKey)}
                    type="button"
                  >
                    Stop capsule
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    disabled={
                      startingKey !== null || readiness?.status === "blocked"
                    }
                    onClick={() =>
                      void startWorkspace(
                        selectedWorkspace.id,
                        selectedTarget.id,
                      )
                    }
                    type="button"
                  >
                    {startingKey === activeKey ? "Starting…" : "Launch capsule"}
                  </button>
                )}
              </div>
            </header>

            <nav className="target-tabs" aria-label="Operational targets">
              {selectedWorkspace.targets.map((target) => {
                const key = sessionKey(selectedWorkspace.id, target.id);
                return (
                  <button
                    className={target.id === selectedTarget.id ? "selected" : ""}
                    key={target.id}
                    onClick={() => {
                      if (target.id === selectedTarget.id) {
                        return;
                      }
                      setSelectedTargetId(target.id);
                      setError(null);
                    }}
                    type="button"
                  >
                    <span
                      className={`target-status ${sessions[key] ? "running" : ""}`}
                    />
                    {target.name}
                  </button>
                );
              })}
            </nav>

            <ContextStrip target={selectedTarget} />

            {error ? <div className="error-banner">{error}</div> : null}
            {catalog && catalog.errors.length > 0 ? (
              <div className="manifest-warning">
                {catalog.errors.length} workspace manifest
                {catalog.errors.length === 1 ? "" : "s"} could not be loaded.
              </div>
            ) : null}

            {Object.entries(sessions).map(([key, session]) => (
              <CapsuleView
                active={key === activeKey}
                key={session.id}
                session={session}
              />
            ))}

            {!selectedSession ? (
              <section className="empty-state">
                <div className="capsule-orbit">
                  <span>OC</span>
                </div>
                <h2>Launch the {selectedTarget.name} target</h2>
                <p>{selectedWorkspace.description}</p>
                <div className="readiness-report">
                  <header>
                    <strong>Target readiness</strong>
                    <span className={`readiness-summary ${readiness?.status ?? "checking"}`}>
                      {readiness?.status ?? "checking"}
                    </span>
                  </header>
                  {readiness?.checks.map((check) => {
                    const hasDetails = Boolean(check.details?.length);
                    const detailsId = `readiness-${check.id}-details`;
                    return (
                      <div
                        aria-describedby={hasDetails ? detailsId : undefined}
                        className={`readiness-check ${hasDetails ? "has-details" : ""}`}
                        key={check.id}
                        tabIndex={hasDetails ? 0 : undefined}
                      >
                        <span className={`readiness-dot ${check.status}`} />
                        <strong>{check.label}</strong>
                        <small>{check.detail}</small>
                        {hasDetails ? (
                          <div
                            className="readiness-details-tooltip"
                            id={detailsId}
                            role="tooltip"
                          >
                            <span>Review details</span>
                            <ul>
                              {check.details?.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {readinessError ? (
                    <div className="readiness-check">
                      <span className="readiness-dot fail" />
                      <strong>Readiness unavailable</strong>
                      <small>{readinessError}</small>
                    </div>
                  ) : null}
                </div>
                <div className="permission-preview">
                  {selectedTarget.directories.map((directory) => (
                    <div key={directory.id}>
                      <span>{directory.access === "read-write" ? "RW" : "RO"}</span>
                      <code>{directory.path}</code>
                    </div>
                  ))}
                </div>
                <button
                  className="primary-button"
                  disabled={
                    startingKey !== null || readiness?.status === "blocked"
                  }
                  onClick={() =>
                    void startWorkspace(
                      selectedWorkspace.id,
                      selectedTarget.id,
                    )
                  }
                  type="button"
                >
                  {startingKey === activeKey
                    ? "Preparing sandbox…"
                    : "Launch capsule"}
                </button>
              </section>
            ) : null}

            <footer className="runtime-footer">
              <span>
                Isolation:{" "}
                <strong>
                  {selectedSession
                    ? selectedSession.isolation.backend
                    : selectedTarget.isolationMode}
                </strong>
                {selectedSession ? ` on ${selectedSession.host.label}` : null}
              </span>
              <code>
                {selectedSession?.runtime.temp ?? selectedWorkspace.sourcePath}
              </code>
            </footer>
          </>
        ) : (
          <section className="empty-state">
            <h2>
              {!catalog
                ? "Loading workspaces…"
                : catalog.errors.length > 0
                  ? "No valid workspace manifests"
                  : "No workspaces configured"}
            </h2>
            {catalog ? <code>{catalog.configDirectory}</code> : null}
          </section>
        )}
      </div>
    </main>
  );
}

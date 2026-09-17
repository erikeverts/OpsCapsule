import { useEffect, useMemo, useState } from "react";
import type {
  WorkspaceDefinition,
  WorkspaceSession,
} from "../../shared/contracts";
import { TerminalPane } from "./components/TerminalPane";

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

export function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [sessions, setSessions] = useState<Record<string, WorkspaceSession>>({});
  const [startingId, setStartingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.opsCapsule
      .listWorkspaces()
      .then((available) => {
        setWorkspaces(available);
        setSelectedId(available[0]?.id ?? "");
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);

  const selectedWorkspace = useMemo(
    () => workspaces.find(({ id }) => id === selectedId),
    [selectedId, workspaces],
  );
  const selectedSession = sessions[selectedId];

  async function startWorkspace(workspaceId: string): Promise<void> {
    if (sessions[workspaceId] || startingId) {
      return;
    }
    setStartingId(workspaceId);
    setError(null);
    try {
      const session = await window.opsCapsule.startWorkspace(workspaceId);
      setSessions((current) => ({ ...current, [workspaceId]: session }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStartingId(null);
    }
  }

  async function stopWorkspace(workspaceId: string): Promise<void> {
    const session = sessions[workspaceId];
    if (!session) {
      return;
    }
    await window.opsCapsule.stopWorkspace(session.id);
    setSessions((current) => {
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">OC</div>
          <div>
            <strong>OpsCapsule</strong>
            <span>Context, contained.</span>
          </div>
        </div>

        <p className="section-label">Capsules</p>
        <nav className="workspace-list" aria-label="Workspaces">
          {workspaces.map((workspace) => {
            const running = Boolean(sessions[workspace.id]);
            return (
              <button
                className={workspace.id === selectedId ? "selected" : ""}
                key={workspace.id}
                onClick={() => setSelectedId(workspace.id)}
                type="button"
              >
                <span className={`status-dot ${running ? "running" : ""}`} />
                <span>
                  <strong>{workspace.name}</strong>
                  <small>
                    {workspace.environment} · {workspace.region}
                  </small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-note">
          <span className="shield">◇</span>
          <div>
            <strong>Isolated by default</strong>
            <span>AWS and Kubernetes context stay inside each capsule.</span>
          </div>
        </div>
      </aside>

      <div className="workspace-area">
        {selectedWorkspace ? (
          <>
            <header className="workspace-header">
              <div>
                <div className="eyebrow">
                  <span className="live-indicator" />
                  {selectedSession ? "Capsule running" : "Capsule ready"}
                </div>
                <h1>{selectedWorkspace.name}</h1>
              </div>
              <div className="header-actions">
                {selectedSession ? (
                  <button
                    className="secondary-button"
                    onClick={() => void stopWorkspace(selectedWorkspace.id)}
                    type="button"
                  >
                    Stop capsule
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    disabled={startingId !== null}
                    onClick={() => void startWorkspace(selectedWorkspace.id)}
                    type="button"
                  >
                    {startingId === selectedWorkspace.id
                      ? "Starting…"
                      : "Launch capsule"}
                  </button>
                )}
              </div>
            </header>

            <section className="context-strip" aria-label="Workspace context">
              <div>
                <span>Account</span>
                <strong>{selectedWorkspace.accountId}</strong>
              </div>
              <div>
                <span>AWS profile</span>
                <strong>{selectedWorkspace.awsProfile}</strong>
              </div>
              <div>
                <span>EKS cluster</span>
                <strong>{selectedWorkspace.cluster}</strong>
              </div>
              <div>
                <span>Namespace</span>
                <strong>{selectedWorkspace.namespace}</strong>
              </div>
            </section>

            {error ? <div className="error-banner">{error}</div> : null}

            {Object.values(sessions).map((session) => (
              <CapsuleView
                active={session.workspace.id === selectedId}
                key={session.id}
                session={session}
              />
            ))}

            {!selectedSession ? (
              <section className="empty-state">
                <div className="capsule-orbit">
                  <span>OC</span>
                </div>
                <h2>Start an isolated operations workspace</h2>
                <p>
                  Three terminals will open with a capsule-specific kubeconfig,
                  AWS profile, region, cluster, and namespace.
                </p>
                <button
                  className="primary-button"
                  disabled={startingId !== null}
                  onClick={() => void startWorkspace(selectedWorkspace.id)}
                  type="button"
                >
                  {startingId === selectedWorkspace.id
                    ? "Starting capsule…"
                    : "Launch capsule"}
                </button>
              </section>
            ) : null}

            <footer className="runtime-footer">
              <span>
                Runtime adapter: <strong>command</strong>
              </span>
              <code>
                {selectedSession?.runtime.kubeconfig ??
                  "KUBECONFIG will be created on launch"}
              </code>
            </footer>
          </>
        ) : (
          <section className="empty-state">
            <h2>Loading workspaces…</h2>
          </section>
        )}
      </div>
    </main>
  );
}


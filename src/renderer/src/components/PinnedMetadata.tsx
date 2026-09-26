import type { MetadataEntry } from "../../../shared/metadata";

interface PinnedMetadataProps {
  entries: MetadataEntry[];
  onError: (message: string) => void;
}

/**
 * The pinned entries for the selected target, kept beside the workspace list
 * so the things people repeatedly hunt for are one glance away.
 *
 * Pinning is a display choice and nothing more: it does not change what the
 * agent is told, which is every entry regardless.
 */
export function PinnedMetadata({ entries, onError }: PinnedMetadataProps) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="pinned-metadata">
      <p className="section-label">Pinned</p>
      <ul className="pinned-list">
        {entries.map((entry) => (
          <li key={entry.key}>
            {entry.kind === "url" ? (
              <button
                className="pinned-link"
                onClick={() => {
                  void window.opsCapsule
                    .openExternal(entry.value)
                    .catch((reason: Error) => onError(reason.message));
                }}
                title={entry.value}
                type="button"
              >
                <span className="pinned-name">{entry.label ?? entry.key}</span>
                <span aria-hidden="true">↗</span>
              </button>
            ) : (
              <div className="pinned-value" title={entry.value}>
                <span className="pinned-name">{entry.label ?? entry.key}</span>
                <span className="pinned-text">{entry.value}</span>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

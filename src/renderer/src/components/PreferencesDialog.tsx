import type { PreferencesState } from "../../../shared/contracts";
import type { ThemePreference } from "../../../shared/preferences";

interface PreferencesDialogProps {
  state: PreferencesState;
  onChange: (theme: ThemePreference) => void;
  onClose: () => void;
}

const themes: Array<{ value: ThemePreference; label: string; hint: string }> = [
  {
    value: "system",
    label: "Match the system",
    hint: "Follows the appearance set in your operating system.",
  },
  { value: "light", label: "Light", hint: "Always use the light theme." },
  { value: "dark", label: "Dark", hint: "Always use the dark theme." },
];

/**
 * Application preferences, as opposed to workspace configuration. Reached from
 * the menu where each platform puts settings, and kept deliberately plain so
 * further settings can be added without redesigning it.
 */
export function PreferencesDialog({
  state,
  onChange,
  onClose,
}: PreferencesDialogProps) {
  return (
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <section aria-label="Preferences" className="dialog" role="dialog">
        <header className="dialog-header">
          <div>
            <div className="eyebrow">Preferences</div>
            <h2>Appearance</h2>
          </div>
          <button className="text-button" onClick={onClose} type="button">
            Close
          </button>
        </header>

        <div className="studio-card">
          <p className="field-hint">
            Applies to OpsCapsule itself. Terminal colours come from the
            programs running inside a capsule.
          </p>
          {themes.map((theme) => (
            <label className="checkbox-field" key={theme.value}>
              <input
                checked={state.preferences.theme === theme.value}
                name="theme"
                onChange={() => onChange(theme.value)}
                type="radio"
              />
              <span>
                {theme.label}
                <span className="field-hint">
                  {theme.hint}
                  {theme.value === "system"
                    ? ` Currently ${state.resolvedTheme}.`
                    : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}

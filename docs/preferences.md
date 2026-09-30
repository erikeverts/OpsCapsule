# Preferences

Preferences belong to the person using OpsCapsule rather than to any
engagement, so they live outside every workspace and are never written to a
manifest. They are stored in `preferences.json` beside the application's other
private state.

Open them where the platform puts settings:

| Platform | Location |
| --- | --- |
| macOS | OpsCapsule → Preferences…, or ⌘, |
| Linux and Windows | File → Preferences, or Ctrl+, |

A damaged or outdated preferences file falls back to the defaults rather than
failing. A theme reverting is an acceptable outcome; refusing to start a
capsule is not.

## Appearance

| Setting | Behaviour |
| --- | --- |
| Match the system | Follows the operating system, and changes with it while the window is open |
| Light | Always light |
| Dark | Always dark |

Following the system is the default, because an application that ignores the
system appearance is the one that looks broken at night. The choice is also
applied to Electron's `nativeTheme`, so the title bar and system dialogs stay
in step with the window, and the window's initial background matches the
resolved theme so launching does not flash the wrong colour.

This applies to OpsCapsule itself. The terminal panes keep a dark palette in
both themes: their colours are an xterm theme whose ANSI values assume a dark
background, and inverting them would make output from programs inside the
capsule harder to read rather than easier.

## Themes

Every colour in the interface is a CSS custom property, defined once per theme
in `src/renderer/src/styles.css`, and organised into ramps:

| Ramp | Purpose |
| --- | --- |
| `--surface-1` … `--surface-12` | Backgrounds and text, darkest to lightest |
| `--accent-1` … `--accent-6` | The cyan the product is built around |
| `--success-*`, `--warning-*`, `--danger-*`, `--info-*` | Status |
| `--scrim-*`, `--tint-*` | Translucent overlays |

The interface previously held 197 distinct colours across 215 usages, most
differing by less than the eye can see. That made a light theme impossible to
write and a custom one impossible to maintain, so they were consolidated into
46 tokens.

Consolidation kept the most-used colour of each group as the representative, so
the colours covering the most screen did not move at all. Half the remaining
usages shift by around two units of CIELAB distance and nine in ten by under
seven, which is between imperceptible and barely visible.

The light values were derived by inverting lightness while keeping hue, then
damping saturated accents and clamping the extremes. That is a starting point
rather than a finished design, and each token is one line to adjust.

A custom theme is a block of the same token names with different values.

A test asserts that no colour appears outside a theme block, that both themes
define the same tokens, and that each declares a `color-scheme` so native
controls follow. A token defined in only one theme would silently inherit the
other's value and produce an unreadable patch.

User-defined themes are not implemented. The token layer is what makes them
possible: a custom theme is a set of values for the same names.

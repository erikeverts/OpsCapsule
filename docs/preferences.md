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

This applies to OpsCapsule itself. Colours inside a terminal come from the
programs running in the capsule.

## Themes

Every colour in the interface is a CSS custom property, defined once per theme
in `src/renderer/src/styles.css`:

```css
:root[data-theme="dark"] { --bg-1: #0b1117; /* … */ }
:root[data-theme="light"] { --bg-1: #e7edf3; /* … */ }
```

The dark values are exactly what the application shipped with, so themes cannot
change how dark mode looks. The light values were derived by inverting
lightness while keeping hue, then damping saturated accents and clamping the
extremes so surfaces stay distinguishable. That is a coherent starting point
rather than a finished design, and individual tokens are meant to be adjusted
by eye.

A test asserts that no colour appears outside a theme block, that both themes
define the same tokens, and that each declares a `color-scheme` so native
controls follow. A token defined in only one theme would silently inherit the
other's value and produce an unreadable patch.

User-defined themes are not implemented. The token layer is what makes them
possible: a custom theme is a set of values for the same names.

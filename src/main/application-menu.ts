import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

/**
 * The application menu, present mainly so Preferences lives where each
 * platform expects it: the application menu on macOS, under File elsewhere.
 *
 * Electron installs a default menu when none is set, which carries the usual
 * edit and window roles but no way to reach application settings. Those roles
 * are kept here rather than replaced, because losing Copy and Paste to gain a
 * Preferences item would be a poor trade.
 */
export function buildApplicationMenu(
  onOpenPreferences: () => void,
): Menu {
  const isMac = process.platform === "darwin";

  const preferencesItem: MenuItemConstructorOptions = {
    label: "Preferences…",
    // The platform conventions differ and both are muscle memory.
    accelerator: isMac ? "Command+," : "Control+,",
    click: () => onOpenPreferences(),
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: "OpsCapsule",
            submenu: [
              { role: "about" },
              { type: "separator" },
              preferencesItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: isMac
        ? [{ role: "close" }]
        : [preferencesItem, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: isMac
        ? [
            { role: "minimize" },
            { role: "zoom" },
            { type: "separator" },
            { role: "front" },
          ]
        : [{ role: "minimize" }, { role: "close" }],
    },
  ];

  return Menu.buildFromTemplate(template);
}

export function installApplicationMenu(getWindow: () => BrowserWindow | null): void {
  Menu.setApplicationMenu(
    buildApplicationMenu(() => {
      // The menu exists whether or not a window does; opening preferences
      // without one would silently do nothing.
      getWindow()?.webContents.send("preferences:open");
    }),
  );
}

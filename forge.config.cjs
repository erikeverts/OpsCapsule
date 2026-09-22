const path = require("node:path");
const { flipFuses, FuseV1Options, FuseVersion } = require("@electron/fuses");

const iconByPlatform = {
  darwin: path.join(__dirname, "assets", "icons", "macos", "OpsCapsule.icns"),
  linux: path.join(__dirname, "assets", "icons", "png", "512x512.png"),
  win32: path.join(__dirname, "assets", "icons", "windows", "OpsCapsule.ico"),
};

module.exports = {
  packagerConfig: {
    appBundleId: "io.github.erikeverts.opscapsule",
    appCategoryType: "public.app-category.developer-tools",
    executableName: "OpsCapsule",
    icon: iconByPlatform[process.platform],
    // Keep preview builds structurally valid after rebranding and flipping
    // fuses. A future trusted release will replace this with Developer ID.
    osxSign: {
      identity: "-",
      identityValidation: false,
      optionsForFile: () => ({
        hardenedRuntime: false,
        entitlements: path.join(__dirname, "build", "entitlements.mac.plist"),
      }),
    },
    ...(process.env.OPSCAPSULE_ELECTRON_CACHE
      ? { download: { cacheRoot: process.env.OPSCAPSULE_ELECTRON_CACHE } }
      : {}),
    asar: {
      // node-pty also spawns a helper executable. Sandbox Runtime ships
      // platform executables and a Java agent. All must be real filesystem
      // paths rather than virtual files inside app.asar.
      unpackDir:
        "{node_modules/node-pty,node_modules/@anthropic-ai/sandbox-runtime/vendor}",
    },
    ignore: [
      /^\/(?:\.git|\.github|build|coverage|docs|examples|out|scripts|src|tests)(?:\/|$)/,
      /^\/\.gitignore$/,
      /^\/node_modules\/\.vite(?:\/|$)/,
      // Forge rebuilds node-pty for the target Electron ABI. Shipping its
      // fallback prebuilds would add every supported OS/architecture again.
      /^\/node_modules\/node-pty\/prebuilds(?:\/|$)/,
      /^\/(?:\.node-version|forge\.config\.cjs|package-lock\.json|tsconfig\.json|vite\.config\.ts|vitest\.config\.ts)$/,
    ],
  },
  rebuildConfig: {
    force: true,
  },
  hooks: {
    // Forge 7's fuse plugin still peers on @electron/fuses 1.x, which does
    // not know Electron 44's WasmTrapHandlers fuse. Run the same pre-signing
    // hook directly so strictlyRequireAllFuses can cover the complete wire.
    packageAfterCopy: async (
      _forgeConfig,
      buildPath,
      _electronVersion,
      platform,
      arch,
    ) => {
      const applePlatform = platform === "darwin" || platform === "mas";
      const executablePath = applePlatform
        ? path.resolve(buildPath, "..", "..", "MacOS", "Electron")
        : path.resolve(
            buildPath,
            "..",
            "..",
            platform === "win32" ? "electron.exe" : "electron",
          );
      await flipFuses(executablePath, {
        version: FuseVersion.V1,
        strictlyRequireAllFuses: true,
        resetAdHocDarwinSignature:
          !_forgeConfig.packagerConfig.osxSign &&
          applePlatform &&
          arch === "arm64",
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: true,
      });
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: "OpsCapsule",
      },
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
  ],
};

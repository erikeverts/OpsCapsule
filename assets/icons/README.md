# OpsCapsule icon assets

`opscapsule.svg` is the canonical source for the application icon. Run:

```sh
npm run icons
```

to regenerate every derived asset.

| Platform/use | Asset |
| --- | --- |
| macOS packaging | `macos/OpsCapsule.icns` |
| Windows packaging | `windows/OpsCapsule.ico` |
| Linux packaging and desktop entries | `png/512x512.png` (plus the other supplied sizes) |
| Electron window and development dock icon | `png/256x256.png` |
| Renderer/favicon | generated copy at `src/renderer/public/opscapsule.svg` |

All PNG, ICO, and ICNS outputs are generated consistently on macOS, Linux, and
Windows. The macOS `.iconset` directory is retained as an inspectable set of
the source resolutions included in the ICNS container.

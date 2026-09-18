import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconRoot = join(repositoryRoot, "assets", "icons");
const sourcePath = join(iconRoot, "opscapsule.svg");
const pngRoot = join(iconRoot, "png");
const macRoot = join(iconRoot, "macos");
const iconsetPath = join(macRoot, "OpsCapsule.iconset");
const windowsRoot = join(iconRoot, "windows");
const rendererIconPath = join(
  repositoryRoot,
  "src",
  "renderer",
  "public",
  "opscapsule.svg",
);

const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const windowsSizes = [16, 24, 32, 48, 64, 128, 256];
const macTypes = [
  [16, "icp4"],
  [32, "icp5"],
  [64, "icp6"],
  [128, "ic07"],
  [256, "ic08"],
  [512, "ic09"],
  [1024, "ic10"],
];
const macFiles = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

function createIco(images) {
  const directorySize = 6 + images.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let imageOffset = directorySize;
  images.forEach(({ size, buffer }, index) => {
    const offset = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, offset);
    header.writeUInt8(size === 256 ? 0 : size, offset + 1);
    header.writeUInt8(0, offset + 2);
    header.writeUInt8(0, offset + 3);
    header.writeUInt16LE(1, offset + 4);
    header.writeUInt16LE(32, offset + 6);
    header.writeUInt32LE(buffer.length, offset + 8);
    header.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += buffer.length;
  });

  return Buffer.concat([header, ...images.map(({ buffer }) => buffer)]);
}

function createIcns(images) {
  const chunks = images.map(({ type, buffer }) => {
    const chunk = Buffer.alloc(8 + buffer.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    buffer.copy(chunk, 8);
    return chunk;
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

async function renderPng(svg, size) {
  return sharp(svg, { density: 384 })
    .resize(size, size, { fit: "fill" })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

async function main() {
  const svg = await readFile(sourcePath);
  await Promise.all([
    mkdir(pngRoot, { recursive: true }),
    mkdir(macRoot, { recursive: true }),
    mkdir(windowsRoot, { recursive: true }),
    mkdir(dirname(rendererIconPath), { recursive: true }),
  ]);
  await rm(iconsetPath, { force: true, recursive: true });
  await mkdir(iconsetPath, { recursive: true });

  const pngs = new Map();
  await Promise.all(
    pngSizes.map(async (size) => {
      const buffer = await renderPng(svg, size);
      pngs.set(size, buffer);
      await writeFile(join(pngRoot, `${size}x${size}.png`), buffer);
    }),
  );

  await Promise.all(
    macFiles.map(([size, filename]) =>
      writeFile(join(iconsetPath, filename), pngs.get(size)),
    ),
  );

  const ico = createIco(
    windowsSizes.map((size) => ({ size, buffer: pngs.get(size) })),
  );
  await writeFile(join(windowsRoot, "OpsCapsule.ico"), ico);
  const icns = createIcns(
    macTypes.map(([size, type]) => ({ type, buffer: pngs.get(size) })),
  );
  await writeFile(join(macRoot, "OpsCapsule.icns"), icns);
  await writeFile(rendererIconPath, svg);

  console.log(`Generated icon assets from ${sourcePath}`);
}

await main();

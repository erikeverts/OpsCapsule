import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageManifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);

if (process.platform !== "darwin") {
  throw new Error(
    `Release artifact preparation currently supports macOS only, not ${process.platform}.`,
  );
}

const outputDirectory = path.join(repositoryRoot, "release");
const platformName = "macos";
const architecture = process.arch;
const artifactStem = `OpsCapsule-${platformName}-${architecture}-${packageManifest.version}-ad-hoc`;
const artifacts = [
  {
    source: path.join(repositoryRoot, "out", "make", "OpsCapsule.dmg"),
    destination: path.join(outputDirectory, `${artifactStem}.dmg`),
  },
  {
    source: path.join(
      repositoryRoot,
      "out",
      "make",
      "zip",
      "darwin",
      architecture,
      `OpsCapsule-darwin-${architecture}-${packageManifest.version}.zip`,
    ),
    destination: path.join(outputDirectory, `${artifactStem}.zip`),
  },
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const artifact of artifacts) {
  await copyFile(artifact.source, artifact.destination);
}

const checksumLines = [];

for (const artifact of artifacts) {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(artifact.destination)) {
    hash.update(chunk);
  }

  checksumLines.push(
    `${hash.digest("hex")}  ${path.basename(artifact.destination)}`,
  );
}

await writeFile(
  path.join(outputDirectory, "SHA256SUMS.txt"),
  `${checksumLines.join("\n")}\n`,
);

console.log(
  `Prepared ${artifacts.length} ad-hoc-signed release artifacts and SHA-256 checksums in ${outputDirectory}.`,
);

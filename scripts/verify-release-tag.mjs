import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageManifest = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);

const [tag, ...unexpectedArguments] = process.argv.slice(2);

if (!tag || unexpectedArguments.length > 0) {
  throw new Error("Usage: npm run verify:release-tag -- v<package-version>");
}

const expectedTag = `v${packageManifest.version}`;

if (tag !== expectedTag) {
  throw new Error(
    `Release tag ${JSON.stringify(tag)} does not match package.json version. Expected ${JSON.stringify(expectedTag)}.`,
  );
}

console.log(`Release tag ${tag} matches package.json version.`);

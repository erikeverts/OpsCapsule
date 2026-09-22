const requiredMajor = 24;
const actualVersion = process.versions.node;
const actualMajor = Number.parseInt(actualVersion.split(".")[0], 10);

if (actualMajor !== requiredMajor) {
  console.error(
    [
      `OpsCapsule requires Node.js ${requiredMajor}.x; the active version is ${actualVersion}.`,
      `Activate Node.js ${requiredMajor} (for example, \`nvm use ${requiredMajor}\`) and retry.`,
      "The version is shared by package.json and .node-version.",
    ].join("\n"),
  );
  process.exit(1);
}

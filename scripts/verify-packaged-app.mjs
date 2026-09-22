import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const {
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} = require("@electron/fuses");

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const appPath =
  process.env.OPSCAPSULE_PACKAGED_APP ??
  path.join(
    repositoryRoot,
    "out",
    `OpsCapsule-darwin-${process.arch}`,
    "OpsCapsule.app",
  );
const resourcesPath = path.join(appPath, "Contents", "Resources");
const executablePath = path.join(appPath, "Contents", "MacOS", "OpsCapsule");
const unpackedModulesPath = path.join(
  resourcesPath,
  "app.asar.unpacked",
  "node_modules",
);
const staticOnly = process.argv.includes("--static-only");

async function requirePath(targetPath, description) {
  try {
    await access(targetPath, constants.F_OK);
  } catch {
    throw new Error(`${description} is missing: ${targetPath}`);
  }
}

async function findFile(root, predicate) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.find((entry) => entry.isFile() && predicate(entry.name));
}

async function verifyPackageLayout() {
  try {
    await access(appPath, constants.F_OK);
  } catch {
    throw new Error(
      `Packaged application is missing: ${appPath}\nRun \`npm run package\` or \`npm run make\` before verification.`,
    );
  }
  await requirePath(path.join(resourcesPath, "app.asar"), "Application ASAR");
  await requirePath(executablePath, "Packaged executable");

  const nodePtyPath = path.join(unpackedModulesPath, "node-pty");
  await requirePath(nodePtyPath, "Unpacked node-pty module");
  const nativeAddon = await findFile(nodePtyPath, (name) =>
    name.endsWith(".node"),
  );
  if (!nativeAddon) {
    throw new Error(
      "The packaged node-pty module has no unpacked native addon",
    );
  }
  const spawnHelperPath = path.join(
    nodePtyPath,
    "build",
    "Release",
    "spawn-helper",
  );
  await requirePath(spawnHelperPath, "node-pty spawn helper");
  if (((await stat(spawnHelperPath)).mode & 0o111) === 0) {
    throw new Error("The packaged node-pty spawn helper is not executable");
  }

  const sandboxVendorPath = path.join(
    unpackedModulesPath,
    "@anthropic-ai",
    "sandbox-runtime",
    "vendor",
  );
  await requirePath(sandboxVendorPath, "Sandbox Runtime vendor resources");
  await requirePath(
    path.join(sandboxVendorPath, "java-proxy-agent", "srt-proxy-agent.jar"),
    "Sandbox Runtime Java proxy agent",
  );
}

async function verifyCodeSignature() {
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", appPath]);
}

async function verifyFuses() {
  const actual = await getCurrentFuseWire(appPath);
  if (actual.version !== FuseVersion.V1) {
    throw new Error(`Unexpected Electron fuse version: ${actual.version}`);
  }

  const disabled = "0".charCodeAt(0);
  const enabled = "1".charCodeAt(0);
  const expected = new Map([
    [FuseV1Options.RunAsNode, disabled],
    [FuseV1Options.EnableCookieEncryption, enabled],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, disabled],
    [FuseV1Options.EnableNodeCliInspectArguments, disabled],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, enabled],
    [FuseV1Options.OnlyLoadAppFromAsar, enabled],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, disabled],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, disabled],
    [FuseV1Options.WasmTrapHandlers, enabled],
  ]);

  for (const [option, expectedState] of expected) {
    if (actual[option] !== expectedState) {
      throw new Error(
        `Electron fuse ${FuseV1Options[option]} has state ${actual[option]}, expected ${expectedState}`,
      );
    }
  }
}

async function launchSmokeTest() {
  const userDataPath = await mkdtemp(
    path.join(tmpdir(), "opscapsule-packaged-smoke-"),
  );
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executablePath, [], {
        env: {
          ...process.env,
          PATH: "/usr/bin:/bin",
          OPSCAPSULE_PACKAGED_SMOKE_TEST: "1",
          OPSCAPSULE_SMOKE_USER_DATA: userDataPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Packaged application smoke test timed out"));
      }, 30_000);

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (
          code !== 0 ||
          !stdout.includes(
            "OpsCapsule packaged application verification passed.",
          )
        ) {
          reject(
            new Error(
              `Packaged application exited with code ${code} and signal ${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
}

if (process.platform !== "darwin") {
  throw new Error(
    "The initial packaged application verifier supports macOS only",
  );
}

await verifyPackageLayout();
await verifyCodeSignature();
await verifyFuses();
if (!staticOnly) {
  await launchSmokeTest();
}
console.log(
  `${staticOnly ? "Static packaged OpsCapsule verification" : "Packaged OpsCapsule verification"} passed: ${appPath}`,
);

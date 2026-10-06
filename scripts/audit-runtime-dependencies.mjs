#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Fails on high or critical advisories in runtime dependencies, except those
 * explicitly accepted.
 *
 * `npm audit` can only be tuned by severity, so a single unfixable advisory
 * would otherwise force the gate down for everything. Accepting one by name,
 * with a reason and a review date, keeps the gate at full strength for
 * everything else. An expired acceptance fails the build, so a risk cannot
 * stay accepted because nobody looked at it again.
 */
const BLOCKING = new Set(["high", "critical"]);

async function auditReport() {
  try {
    const { stdout } = await run("npm", ["audit", "--omit=dev", "--json"], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    // npm exits non-zero when it finds anything, and still prints the report.
    if (error.stdout) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

function advisoriesFrom(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    if (!BLOCKING.has(vulnerability.severity)) {
      continue;
    }
    for (const via of vulnerability.via) {
      if (typeof via !== "object") {
        continue;
      }
      const id = via.url?.split("/").pop() ?? via.source?.toString();
      if (id) {
        found.set(id, {
          id,
          package: via.name ?? vulnerability.name,
          severity: via.severity ?? vulnerability.severity,
          title: via.title ?? "",
        });
      }
    }
  }
  return [...found.values()];
}

const [report, acceptedFile] = await Promise.all([
  auditReport(),
  readFile(new URL("../security/accepted-advisories.json", import.meta.url), "utf8"),
]);

const today = new Date();
const accepted = new Map(
  JSON.parse(acceptedFile).accepted.map((entry) => [entry.id, entry]),
);

const expired = [...accepted.values()].filter(
  (entry) => new Date(entry.expires) < today,
);
if (expired.length > 0) {
  console.error("These acceptances have expired and must be reviewed again:");
  for (const entry of expired) {
    console.error(`  ${entry.id} (${entry.package}) expired ${entry.expires}`);
  }
  process.exit(1);
}

const found = advisoriesFrom(report);
const unaccepted = found.filter((advisory) => !accepted.has(advisory.id));

for (const advisory of found) {
  if (accepted.has(advisory.id)) {
    const entry = accepted.get(advisory.id);
    console.log(
      `accepted ${advisory.id} (${advisory.package}), review by ${entry.expires}`,
    );
  }
}

if (unaccepted.length > 0) {
  console.error(`\n${unaccepted.length} unaccepted advisory(ies):`);
  for (const advisory of unaccepted) {
    console.error(`  ${advisory.severity}: ${advisory.package} ${advisory.id}`);
    console.error(`    ${advisory.title}`);
  }
  console.error(
    "\nFix it, or record an acceptance with a reason and a review date in" +
      " security/accepted-advisories.json.",
  );
  process.exit(1);
}

console.log(`runtime dependencies clear (${found.length} accepted)`);

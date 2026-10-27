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

const acceptedDocument = JSON.parse(acceptedFile);
if (!Array.isArray(acceptedDocument.accepted)) {
  throw new Error("security/accepted-advisories.json needs an 'accepted' array.");
}

const invalid = acceptedDocument.accepted.filter((entry) => {
  if (
    !entry ||
    typeof entry.id !== "string" ||
    typeof entry.package !== "string" ||
    typeof entry.reason !== "string" ||
    entry.reason.trim() === "" ||
    typeof entry.expires !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)
  ) {
    return true;
  }
  return (
    new Date(`${entry.expires}T00:00:00.000Z`).toISOString().slice(0, 10) !==
    entry.expires
  );
});
if (invalid.length > 0) {
  console.error(
    "Every acceptance needs a valid id, package, non-empty reason, and YYYY-MM-DD expiry.",
  );
  process.exit(1);
}

const accepted = new Map();
for (const entry of acceptedDocument.accepted) {
  if (accepted.has(entry.id)) {
    console.error(`Duplicate advisory acceptance: ${entry.id}`);
    process.exit(1);
  }
  accepted.set(entry.id, entry);
}

const today = new Date().toISOString().slice(0, 10);

const expired = [...accepted.values()].filter(
  (entry) => entry.expires < today,
);
if (expired.length > 0) {
  console.error("These acceptances have expired and must be reviewed again:");
  for (const entry of expired) {
    console.error(`  ${entry.id} (${entry.package}) expired ${entry.expires}`);
  }
  process.exit(1);
}

const found = advisoriesFrom(report);
const foundById = new Map(found.map((advisory) => [advisory.id, advisory]));
const obsolete = [...accepted.values()].filter(
  (entry) => !foundById.has(entry.id),
);
if (obsolete.length > 0) {
  console.error("These accepted advisories are no longer reported and must be removed:");
  for (const entry of obsolete) {
    console.error(`  ${entry.id} (${entry.package})`);
  }
  process.exit(1);
}

const mismatched = [...accepted.values()].filter(
  (entry) => foundById.get(entry.id)?.package !== entry.package,
);
if (mismatched.length > 0) {
  console.error("These advisory acceptances name the wrong package:");
  for (const entry of mismatched) {
    console.error(
      `  ${entry.id}: policy names ${entry.package}, audit reports ${foundById.get(entry.id)?.package}`,
    );
  }
  process.exit(1);
}

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

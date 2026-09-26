import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type {
  CredentialKind,
  CredentialReference,
  CredentialScope,
} from "../../shared/credentials.js";
import { CredentialStore, scopeContext } from "./store.js";

/**
 * Developer CLI for populating the credential store.
 *
 * It runs under Electron on purpose: `safeStorage` is the real OS-backed
 * encryption the application uses, so this exercises the same code path rather
 * than writing a test fixture that the running app could not read. It is the
 * stand-in for the authentication UI, which is a later slice.
 */
interface Options {
  command: string;
  id?: string;
  scope: CredentialScope;
  kind: CredentialKind;
  name?: string;
  providerId?: string;
  workspace?: string;
  target?: string;
  file?: string;
}

function parseArguments(argv: string[]): Options {
  const options: Options = {
    command: argv[0] ?? "help",
    scope: "user",
    kind: "aws-profile",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      continue;
    }
    index += 1;
    switch (flag) {
      case "--id":
        options.id = value;
        break;
      case "--scope":
        options.scope = value as CredentialScope;
        break;
      case "--kind":
        options.kind = value as CredentialKind;
        break;
      case "--name":
        options.name = value;
        break;
      case "--provider":
        options.providerId = value;
        break;
      case "--workspace":
        options.workspace = value;
        break;
      case "--target":
        options.target = value;
        break;
      case "--file":
        options.file = value;
        break;
      default:
        break;
    }
  }
  return options;
}

function usage(): string {
  return [
    "Usage: npm run credentials -- <command> [flags]",
    "",
    "Commands:",
    "  set     Store a secret for a credential reference",
    "  status  Report whether a secret is stored",
    "  remove  Delete a stored secret (logout)",
    "",
    "Flags:",
    "  --id <id>            Credential reference id (required)",
    "  --scope <scope>      user | workspace | target   (default: user)",
    "  --kind <kind>        aws-profile | provider-oauth",
    "  --provider <id>      Provider id for provider-oauth, e.g. opencode",
    "  --workspace <id>     Required for workspace and target scope",
    "  --target <id>        Required for target scope",
    "  --file <path>        Read the secret from a file instead of stdin",
    "",
    "Examples:",
    "  npm run credentials -- set --id central-inference --scope user \\",
    "    --kind provider-oauth --provider opencode \\",
    "    --file ~/.local/share/opencode/auth.json",
    "",
    "  npm run credentials -- set --id target-operational --scope target \\",
    "    --kind aws-profile --workspace atlas --target production \\",
    "    --file ./aws-session.json",
    "",
    "  An aws-profile secret is JSON:",
    '    {"accessKeyId":"...","secretAccessKey":"...","sessionToken":"...",',
    '     "expiration":"2026-01-01T00:00:00Z"}',
  ].join("\n");
}

async function readSecret(file?: string): Promise<string> {
  if (file) {
    return readFile(file.replace(/^~(?=\/)/, process.env.HOME ?? "~"), "utf8");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const secret = Buffer.concat(chunks).toString("utf8").trim();
  if (!secret) {
    throw new Error("No secret was supplied on stdin. Use --file or pipe one in.");
  }
  return secret;
}

async function main(): Promise<number> {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "help" || !options.id) {
    console.log(usage());
    return options.id ? 0 : 1;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    console.error(
      "OS-backed encryption is unavailable, so no credential can be stored.",
    );
    return 1;
  }

  const reference: CredentialReference = {
    id: options.id,
    name: options.name ?? options.id,
    kind: options.kind,
    scope: options.scope,
    ...(options.providerId ? { providerId: options.providerId } : {}),
  };

  if (options.scope !== "user" && !options.workspace) {
    console.error(`A ${options.scope}-scoped credential needs --workspace.`);
    return 1;
  }
  if (options.scope === "target" && !options.target) {
    console.error("A target-scoped credential needs --target.");
    return 1;
  }

  const store = new CredentialStore(app.getPath("userData"), safeStorage);
  console.log(`Using ${app.getName()} data at ${app.getPath("userData")}`);
  const context = scopeContext(options.scope, {
    workspaceId: options.workspace ?? "",
    targetId: options.target ?? "",
  });

  switch (options.command) {
    case "set": {
      const secret = await readSecret(options.file);
      if (options.kind !== "provider-oauth") {
        // Fail early rather than at credential time inside a capsule.
        const parsed = JSON.parse(secret) as Record<string, unknown>;
        for (const field of ["accessKeyId", "secretAccessKey", "sessionToken"]) {
          if (!parsed[field]) {
            throw new Error(`An ${options.kind} secret needs a '${field}' field.`);
          }
        }
      }
      await store.write(reference, secret, context);
      console.log(
        `Stored ${options.scope}-scoped '${options.id}' for OpsCapsule.`,
      );
      return 0;
    }
    case "status": {
      const stored = await store.has(reference, context);
      console.log(
        `${options.id}: ${stored ? "authenticated" : "not authenticated"} (${options.scope} scope)`,
      );
      return 0;
    }
    case "remove": {
      await store.forget(reference, context);
      console.log(`Removed the stored secret for '${options.id}'.`);
      return 0;
    }
    default:
      console.log(usage());
      return 1;
  }
}

/**
 * Electron only derives the application name from package.json when it is
 * launched with a directory. This CLI is launched with a file, so without this
 * the name falls back to "Electron" and the secret would be written to a
 * userData directory the application never reads. Reproduce Electron's own
 * rule: productName if present, otherwise name.
 */
function alignApplicationName(): void {
  try {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    ) as { name?: string; productName?: string };
    const resolved = manifest.productName ?? manifest.name;
    if (resolved) {
      app.setName(resolved);
      app.setPath("userData", join(app.getPath("appData"), resolved));
    }
  } catch {
    // Fall through: the explicit check below reports the directory in use.
  }
}

alignApplicationName();

app.whenReady().then(async () => {
  try {
    app.exit(await main());
  } catch (error) {
    console.error((error as Error).message);
    app.exit(1);
  }
});

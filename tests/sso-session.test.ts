import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeSsoSession,
  readSsoSessionState,
  ssoSessionSeverity,
} from "../src/main/credentials/sso-session.js";
import {
  describeSsoExpiry,
  ssoSeverityFor,
} from "../src/shared/credentials.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(options: {
  config: string;
  tokens: Array<Record<string, unknown>>;
}) {
  const base = await mkdtemp("/tmp/oc-sso-");
  temporary.push(base);
  const configFile = join(base, "config");
  const cacheDirectory = join(base, "cache");
  await writeFile(configFile, options.config);
  await mkdir(cacheDirectory, { recursive: true });
  await Promise.all(
    options.tokens.map((token, index) =>
      writeFile(join(cacheDirectory, `${index}.json`), JSON.stringify(token)),
    ),
  );
  return { configFile, cacheDirectory };
}

// A fixed clock. Deriving "now" separately inside the formatter loses a
// millisecond and floors 6h to "5h left", which passes or fails by timing.
const NOW = new Date("2026-09-25T12:00:00.000Z");
const fromNow = (ms: number) => new Date(NOW.getTime() + ms);

const inOneHour = new Date(Date.now() + 3_600_000).toISOString();
const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString();

const sessionConfig = [
  "[profile ri-obs-use1-dev]",
  "sso_session = hsp-sso",
  "region = us-east-1",
  "",
  "[sso-session hsp-sso]",
  "sso_region = us-east-1",
  "sso_start_url = https://hsp.awsapps.com/start/#/",
].join("\n");

describe("SSO session severity", () => {
  const at = (minutes: number) => ({
    expiresAt: fromNow(minutes * 60_000),
    canRenewSilently: false,
  });

  it("is quiet while there is comfortable time left", () => {
    expect(ssoSessionSeverity(at(120), NOW)).toBe("ok");
    expect(ssoSessionSeverity(at(16), NOW)).toBe("ok");
  });

  it("warns inside the last fifteen minutes", () => {
    expect(ssoSessionSeverity(at(14), NOW)).toBe("expiring");
    expect(ssoSessionSeverity(at(1), NOW)).toBe("expiring");
  });

  it("reports expiry once the session has lapsed", () => {
    expect(ssoSessionSeverity(at(-1), NOW)).toBe("expired");
  });

  it("counts down the access token even when a refresh token exists", () => {
    // A refresh token does not mean renewal happens. How long a user stays
    // signed in is the Identity Center session duration, commonly eight
    // hours, and it is not in the cache. Trusting the ninety day client
    // registration produced a two month deadline on a host that in fact
    // signed in every morning.
    const state = { expiresAt: fromNow(6 * 3_600_000), canRenewSilently: true };
    expect(describeSsoSession(state, NOW)).toBe("Signed in, 6h left");
    expect(ssoSessionSeverity(state, NOW)).toBe("ok");
  });

  it("warns as the access token runs out, refresh token or not", () => {
    const state = { expiresAt: fromNow(10 * 60_000), canRenewSilently: true };
    expect(ssoSessionSeverity(state, NOW)).toBe("expiring");
    expect(describeSsoSession(state, NOW)).toBe("Expires in 10m");
  });

  it("does not claim an expired session is fine because it might renew", () => {
    const renewable = { expiresAt: fromNow(-60_000), canRenewSilently: true };
    expect(ssoSessionSeverity(renewable, NOW)).toBe("expired");
    // Honest about the uncertainty: it may renew, and if it does the next
    // read clears this by itself.
    expect(describeSsoSession(renewable, NOW)).toBe("Renewing or expired");
  });

  it("has no severity for a profile that does not use SSO", () => {
    expect(ssoSessionSeverity(undefined, NOW)).toBeUndefined();
  });
});

describe("SSO session expiry", () => {
  it("reads expiry without ever reading a token value", async () => {
    const paths = await fixture({
      config: sessionConfig,
      tokens: [
        {
          accessToken: "SECRET-ACCESS",
          startUrl: "https://hsp.awsapps.com/start#",
          expiresAt: inOneHour,
          region: "us-east-1",
        },
      ],
    });
    const state = await readSsoSessionState("ri-obs-use1-dev", paths);
    expect(state).toBeDefined();
    // The cache holds several spellings of one start URL; matching normalizes.
    expect(state!.expiresAt.toISOString()).toBe(inOneHour);
    expect(JSON.stringify(state)).not.toContain("SECRET-ACCESS");
  });

  it("ignores client registrations, which carry no session", async () => {
    const paths = await fixture({
      config: sessionConfig,
      tokens: [
        { clientId: "id", clientSecret: "SECRET", expiresAt: nextYear },
      ],
    });
    expect(await readSsoSessionState("ri-obs-use1-dev", paths)).toBeUndefined();
  });

  it("uses the newest entry when stale ones exist for the same start URL", async () => {
    const paths = await fixture({
      config: sessionConfig,
      tokens: [
        {
          accessToken: "old",
          startUrl: "https://hsp.awsapps.com/start/#/",
          expiresAt: anHourAgo,
        },
        {
          accessToken: "new",
          startUrl: "https://hsp.awsapps.com/start/#",
          expiresAt: inOneHour,
        },
      ],
    });
    const state = await readSsoSessionState("ri-obs-use1-dev", paths);
    expect(state!.expiresAt.toISOString()).toBe(inOneHour);
  });

  it("still records whether a refresh token is present", async () => {
    const paths = await fixture({
      config: sessionConfig,
      tokens: [
        {
          accessToken: "a",
          refreshToken: "r",
          startUrl: "https://hsp.awsapps.com/start/#/",
          expiresAt: anHourAgo,
          registrationExpiresAt: nextYear,
        },
      ],
    });
    const state = await readSsoSessionState("ri-obs-use1-dev", paths);
    // Warning here would be a false alarm: the CLI renews without the user.
    expect(state!.canRenewSilently).toBe(true);
    // Present, but it does not suppress the warning: the session may still
    // require an interactive sign-in and the cache cannot tell us.
    expect(describeSsoSession(state)).toBe("Renewing or expired");
  });

  it("reports an expired session whose registration has also lapsed", async () => {
    const paths = await fixture({
      config: sessionConfig,
      tokens: [
        {
          accessToken: "a",
          refreshToken: "r",
          startUrl: "https://hsp.awsapps.com/start/#/",
          expiresAt: anHourAgo,
          registrationExpiresAt: anHourAgo,
        },
      ],
    });
    const state = await readSsoSessionState("ri-obs-use1-dev", paths);
    expect(state!.canRenewSilently).toBe(false);
    expect(describeSsoSession(state)).toBe("Sign-in expired");
  });

  it("supports a legacy profile that names the start URL directly", async () => {
    const paths = await fixture({
      config: [
        "[profile legacy]",
        "sso_start_url = https://hsp.awsapps.com/start",
        "sso_region = us-east-1",
      ].join("\n"),
      tokens: [
        {
          accessToken: "a",
          startUrl: "https://hsp.awsapps.com/start/#/",
          expiresAt: inOneHour,
        },
      ],
    });
    expect(await readSsoSessionState("legacy", paths)).toBeDefined();
  });

  it("returns nothing for a profile that does not use SSO", async () => {
    const paths = await fixture({
      config: ["[profile static]", "region = eu-west-1"].join("\n"),
      tokens: [],
    });
    expect(await readSsoSessionState("static", paths)).toBeUndefined();
  });
});

describe("shared countdown formatting", () => {
  it("produces the same text in the renderer as the main process", () => {
    // The sidebar recomputes the countdown locally between reads, so the two
    // must not drift apart in wording or thresholds.
    const expiresAt = fromNow(90 * 60_000);
    const state = { expiresAt, canRenewSilently: false };
    expect(describeSsoSession(state, NOW)).toBe(
      describeSsoExpiry(expiresAt, false, NOW),
    );
    expect(ssoSessionSeverity(state, NOW)).toBe(ssoSeverityFor(expiresAt, NOW));
  });

  it("moves the countdown forward as time passes", () => {
    const expiresAt = fromNow(60 * 60_000);
    const later = fromNow(30 * 60_000);
    expect(describeSsoExpiry(expiresAt, false, NOW)).toBe("Signed in, 1h left");
    expect(describeSsoExpiry(expiresAt, false, later)).toBe("Expires in 30m");
    expect(ssoSeverityFor(expiresAt, later)).toBe("ok");
  });

  it("crosses into amber and then red without a re-read", () => {
    const expiresAt = fromNow(60 * 60_000);
    const nearlyDue = new Date(expiresAt.getTime() - 10 * 60_000);
    const overdue = new Date(expiresAt.getTime() + 60_000);
    expect(ssoSeverityFor(expiresAt, nearlyDue)).toBe("expiring");
    expect(ssoSeverityFor(expiresAt, overdue)).toBe("expired");
  });
});

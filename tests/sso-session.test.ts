import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeSsoSession,
  readSsoSessionState,
  ssoSessionSeverity,
} from "../src/main/credentials/sso-session.js";

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
    expiresAt: new Date(Date.now() + minutes * 60_000),
    canRenewSilently: false,
  });

  it("is quiet while there is comfortable time left", () => {
    expect(ssoSessionSeverity(at(120))).toBe("ok");
    expect(ssoSessionSeverity(at(16))).toBe("ok");
  });

  it("warns inside the last fifteen minutes", () => {
    expect(ssoSessionSeverity(at(14))).toBe("expiring");
    expect(ssoSessionSeverity(at(1))).toBe("expiring");
  });

  it("reports expiry once the session has lapsed", () => {
    expect(ssoSessionSeverity(at(-1))).toBe("expired");
  });

  it("shows no countdown for a session that renews itself", () => {
    // Real AWS SSO access tokens last about an hour and refresh silently, so
    // a remaining-time figure is noise rather than information.
    expect(
      describeSsoSession({
        expiresAt: new Date(Date.now() + 29 * 60_000),
        canRenewSilently: true,
        renewableUntil: new Date(Date.now() + 59 * 86_400_000),
      }),
    ).toBe("Signed in");
  });

  it("counts down to the registration deadline, not the access token", () => {
    // The refresh registration is what eventually forces an interactive
    // sign-in, and without this the user would get at most an hour of notice.
    const state = {
      expiresAt: new Date(Date.now() + 40 * 60_000),
      canRenewSilently: true,
      renewableUntil: new Date(Date.now() + 6 * 3_600_000),
    };
    expect(describeSsoSession(state)).toBe("Signed in, 6h left");
    expect(ssoSessionSeverity(state)).toBe("ok");
  });

  it("warns as the registration deadline arrives", () => {
    const state = {
      expiresAt: new Date(Date.now() + 40 * 60_000),
      canRenewSilently: true,
      renewableUntil: new Date(Date.now() + 10 * 60_000),
    };
    // The access token is still fine, but renewal is about to stop working.
    expect(ssoSessionSeverity(state)).toBe("expiring");
    expect(describeSsoSession(state)).toBe("Expires in 10m");
  });

  it("reports expiry once renewal is no longer possible", () => {
    const state = {
      expiresAt: new Date(Date.now() + 40 * 60_000),
      canRenewSilently: true,
      renewableUntil: new Date(Date.now() - 60_000),
    };
    expect(ssoSessionSeverity(state)).toBe("expired");
  });

  it("stays quiet for an expired access token that renews itself", () => {
    // Colouring a session the CLI renews without the user would train people
    // to ignore the colour.
    const renewable = {
      expiresAt: new Date(Date.now() - 60_000),
      canRenewSilently: true,
      renewableUntil: new Date(Date.now() + 59 * 86_400_000),
    };
    expect(ssoSessionSeverity(renewable)).toBe("ok");
    expect(describeSsoSession(renewable)).toBe("Signed in");
  });

  it("has no severity for a profile that does not use SSO", () => {
    expect(ssoSessionSeverity(undefined)).toBeUndefined();
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

  it("carries the registration deadline so renewal loss can be anticipated", async () => {
    const paths = await fixture({
      config: sessionConfig,
      tokens: [
        {
          accessToken: "a",
          refreshToken: "r",
          startUrl: "https://hsp.awsapps.com/start/#/",
          expiresAt: inOneHour,
          registrationExpiresAt: nextYear,
        },
      ],
    });
    const state = await readSsoSessionState("ri-obs-use1-dev", paths);
    expect(state!.renewableUntil?.toISOString()).toBe(nextYear);
  });

  it("does not report an expired session that renews itself", async () => {
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
    // A countdown here would show an alarming number for a non-event.
    expect(describeSsoSession(state)).toBe("Signed in");
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

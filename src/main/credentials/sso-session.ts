import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { iniSections } from "../local-resources.js";

/**
 * Reads AWS SSO session expiry from the CLI's own token cache.
 *
 * Resolving a profile is authoritative but costs a subprocess, which is too
 * expensive to do repeatedly for a status display. The cache gives the same
 * answer from a file read, and gives a time rather than a yes or no, so a
 * session can be shown as expiring before it actually fails.
 *
 * Only expiry metadata is read. Access and refresh tokens are never read,
 * returned, or logged.
 */
export interface SsoSessionState {
  /** When the cached access token stops being usable. */
  readonly expiresAt: Date;
  /**
   * Whether the CLI can renew without the user, because a refresh token is
   * present and its registration is still valid. An expired access token with
   * a usable refresh token is not something to warn about.
   */
  readonly canRenewSilently: boolean;
  /**
   * When the refresh registration itself lapses, after which an interactive
   * sign-in is unavoidable. This, not the access token, is the deadline that
   * eventually requires the user.
   */
  readonly renewableUntil?: Date;
}

/**
 * The cache holds several spellings of the same start URL, such as
 * `.../start#`, `.../start/#` and `.../start/#/`, so matching normalizes
 * before comparing.
 */
function normalizeStartUrl(value: string): string {
  return value.trim().replace(/[#/]+$/, "").toLowerCase();
}

interface CachedToken {
  startUrl?: string;
  region?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  registrationExpiresAt?: string;
}

async function ssoStartUrlForProfile(
  profile: string,
  configFile: string,
): Promise<{ startUrl: string; region?: string } | undefined> {
  let sections;
  try {
    sections = iniSections(await readFile(configFile, "utf8"));
  } catch {
    return undefined;
  }
  const profileSection = sections.find(
    (section) => section.name === `profile ${profile}` || section.name === profile,
  );
  if (!profileSection) {
    return undefined;
  }

  // Legacy profiles carry the start URL directly; newer ones name a session.
  const direct = profileSection.values.get("sso_start_url");
  if (direct) {
    return { startUrl: direct, region: profileSection.values.get("sso_region") };
  }
  const sessionName = profileSection.values.get("sso_session");
  if (!sessionName) {
    return undefined;
  }
  const session = sections.find(
    (section) => section.name === `sso-session ${sessionName}`,
  );
  const startUrl = session?.values.get("sso_start_url");
  return startUrl
    ? { startUrl, region: session?.values.get("sso_region") }
    : undefined;
}

export async function readSsoSessionState(
  profile: string,
  options: {
    configFile?: string;
    cacheDirectory?: string;
  } = {},
): Promise<SsoSessionState | undefined> {
  const configFile =
    options.configFile ?? join(homedir(), ".aws", "config");
  const cacheDirectory =
    options.cacheDirectory ?? join(homedir(), ".aws", "sso", "cache");

  const target = await ssoStartUrlForProfile(profile, configFile);
  if (!target) {
    // Not an SSO profile, so there is no session to expire.
    return undefined;
  }
  const wanted = normalizeStartUrl(target.startUrl);

  let files: string[];
  try {
    files = await readdir(cacheDirectory);
  } catch {
    return undefined;
  }

  const now = Date.now();
  let best: SsoSessionState | undefined;

  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    let token: CachedToken;
    try {
      token = JSON.parse(
        await readFile(join(cacheDirectory, file), "utf8"),
      ) as CachedToken;
    } catch {
      continue;
    }
    // Client registrations live here too and carry no token or start URL.
    if (!token.accessToken || !token.startUrl || !token.expiresAt) {
      continue;
    }
    if (normalizeStartUrl(token.startUrl) !== wanted) {
      continue;
    }
    const expiresAt = new Date(token.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      continue;
    }
    const registrationExpiresAt = token.registrationExpiresAt
      ? new Date(token.registrationExpiresAt)
      : undefined;
    const canRenewSilently = Boolean(
      token.refreshToken &&
        registrationExpiresAt &&
        !Number.isNaN(registrationExpiresAt.getTime()) &&
        registrationExpiresAt.getTime() > now,
    );

    // Several stale entries exist per start URL; the newest one is in use.
    if (!best || expiresAt.getTime() > best.expiresAt.getTime()) {
      best = {
        expiresAt,
        canRenewSilently,
        ...(canRenewSilently && registrationExpiresAt
          ? { renewableUntil: registrationExpiresAt }
          : {}),
      };
    }
  }

  return best;
}

/**
 * How prominently a session should be shown.
 *
 * Severity is gated on whether the user actually has to do something. A
 * session the CLI can renew by itself is not a problem however close to expiry
 * it is, and colouring it would train people to ignore the colour.
 */
export type SsoSessionSeverity = "ok" | "expiring" | "expired";

/** Amber inside this window, because a sign-in takes a browser round trip. */
export const SSO_EXPIRY_WARNING_MS = 15 * 60_000;

/** Start showing the registration deadline a day out, so it is not a surprise. */
export const SSO_RENEWAL_NOTICE_MS = 24 * 3_600_000;

/**
 * The moment the user will actually have to sign in again.
 *
 * While the CLI can renew by itself that is when the refresh registration
 * lapses, which is months away. Once it cannot, it is whatever is left of the
 * current access token.
 */
export function signInDeadline(state: SsoSessionState): Date {
  return state.canRenewSilently && state.renewableUntil
    ? state.renewableUntil
    : state.expiresAt;
}

export function ssoSessionSeverity(
  state: SsoSessionState | undefined,
  now = new Date(),
): SsoSessionSeverity | undefined {
  if (!state) {
    return undefined;
  }
  if (state.canRenewSilently && !state.renewableUntil) {
    // Renewable with no known registration deadline: nothing to warn about.
    return "ok";
  }
  const remainingMs = signInDeadline(state).getTime() - now.getTime();
  if (remainingMs <= 0) {
    return "expired";
  }
  return remainingMs < SSO_EXPIRY_WARNING_MS ? "expiring" : "ok";
}

export function describeSsoSession(
  state: SsoSessionState | undefined,
  now = new Date(),
): string | undefined {
  if (!state) {
    return undefined;
  }
  // No countdown when the CLI renews by itself. Modern SSO access tokens last
  // about an hour and are refreshed automatically, so a countdown would show
  // an alarming number continuously for something that never needs action. The
  // deadline that does matter is when the refresh registration lapses, which
  // is months away and is reflected by canRenewSilently turning false.
  // Kept short: this sits in a narrow sidebar, not a settings page.
  const remainingMs = signInDeadline(state).getTime() - now.getTime();
  if (remainingMs <= 0) {
    return "Sign-in expired";
  }
  if (state.canRenewSilently && remainingMs > SSO_RENEWAL_NOTICE_MS) {
    // Months away, and renewing needs nothing from the user until then.
    return "Signed in";
  }
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  return hours > 0 ? `Signed in, ${hours}h left` : `Expires in ${minutes}m`;
}

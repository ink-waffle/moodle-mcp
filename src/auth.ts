import type { BrowserContext, Page } from "playwright-core";
import { closeContext, closePage, getContext, openPage } from "./browser.js";
import { fetchPublicConfig, type PublicConfig } from "./ws.js";

export interface MintedToken {
  token: string;
  privatetoken?: string;
}

/**
 * Sites with typeoflogin 1 accept the plain credential exchange, no browser needed.
 * SSO sites reject it, which is why the browser path below exists.
 */
export async function mintTokenViaPassword(
  baseUrl: string,
  username: string,
  password: string,
  service = "moodle_mobile_app",
): Promise<MintedToken> {
  const res = await fetch(`${baseUrl}/login/token.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password, service }).toString(),
  });
  const body = (await res.json()) as { token?: string; privatetoken?: string; error?: string; errorcode?: string };
  if (body.token) return { token: body.token, privatetoken: body.privatetoken };
  throw new Error(
    `${baseUrl} refused the username/password token exchange${body.errorcode ? ` (${body.errorcode})` : ""}: ${body.error ?? "unknown error"}`,
  );
}

function decodeAppToken(location: string): MintedToken | null {
  // e.g. moodlemobile://token=<base64( md5(siteid+passport) ":::" token [":::" privatetoken] )>
  const m = /token=([A-Za-z0-9+/=%]+)/.exec(location);
  if (!m?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(decodeURIComponent(m[1]), "base64").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":::");
  // parts[0] is the passport signature, which only the official app needs to verify.
  if (parts.length < 2 || !parts[1]) return null;
  return { token: parts[1], privatetoken: parts[2] || undefined };
}

function launchUrl(baseUrl: string, config: PublicConfig | undefined, passport: number): string {
  const base = config?.launchurl || `${baseUrl}/admin/tool/mobile/launch.php`;
  const u = new URL(base);
  u.searchParams.set("service", "moodle_mobile_app");
  u.searchParams.set("passport", String(passport));
  u.searchParams.set("urlscheme", "moodlemobile");
  return u.toString();
}

/** Set when a probe failed for a reason other than "user is not logged in yet". */
let lastLaunchProblem: string | undefined;
/** The login tab we opened, so repeated connect calls reuse it instead of piling up. */
let loginPage: Page | undefined;

/**
 * Ask launch.php for a token using whatever session the browser holds.
 * Returns null while the user is still logged out — launch.php then answers a
 * 303 to /login — and also on transient network trouble, so the caller can just
 * keep polling instead of failing the whole connect.
 */
async function tryLaunch(ctx: BrowserContext, baseUrl: string, config?: PublicConfig): Promise<MintedToken | null> {
  const url = launchUrl(baseUrl, config, Math.floor(Math.random() * 1_000_000_000));
  let needsBrowserFallback = false;

  // Preferred: an API request on the context's cookie jar, invisible to the user's tabs.
  try {
    const res = await ctx.request.get(url, { maxRedirects: 0, timeout: 30_000 });
    const location = res.headers()["location"] ?? "";
    if (location.includes("token=")) {
      lastLaunchProblem = undefined;
      return decodeAppToken(location);
    }
    if (res.status() >= 300 && res.status() < 400) return null; // bounced to login: not authenticated yet
    // A rendered page instead of a redirect means the site wants a human — some
    // installs interpose a confirmation step. Show it rather than guessing.
    needsBrowserFallback = res.status() === 200;
    if (!needsBrowserFallback) {
      lastLaunchProblem = `launch.php answered HTTP ${res.status()}`;
      return null;
    }
  } catch (e) {
    const message = (e as Error).message.split("\n")[0] ?? "";
    // Some Playwright builds throw instead of surfacing an unfollowed redirect.
    if (/redirect/i.test(message)) {
      needsBrowserFallback = true;
    } else {
      // Transient: a browser that just started, a dropped socket, a slow network.
      lastLaunchProblem = message;
      return null;
    }
  }

  if (!needsBrowserFallback) return null;

  // Fallback: watch the redirect on a real navigation. Chrome aborts the
  // moodlemobile:// hop, so the goto rejects after we have already seen the header.
  const page = await ctx.newPage();
  let found: MintedToken | null = null;
  page.on("response", (res) => {
    if (found) return;
    const location = res.headers()["location"] ?? "";
    if (res.status() >= 300 && res.status() < 400 && location.includes("token=")) {
      found = decodeAppToken(location);
    }
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    if (!found) {
      // Leave the tab open: whatever it is showing needs the human's attention.
      lastLaunchProblem = `launch.php rendered a page instead of redirecting — see the browser tab at ${page.url()}`;
      return null;
    }
  } finally {
    if (found) await page.close().catch(() => {});
  }
  lastLaunchProblem = undefined;
  return found;
}

export interface BrowserMintResult {
  status: "minted" | "waiting";
  token?: MintedToken;
  detail: string;
}

/**
 * Open the site's login page in the managed browser and poll launch.php until a
 * token appears. Returns "waiting" rather than blocking for minutes, so the MCP
 * client does not time out — calling again resumes with the same live browser.
 */
export async function mintTokenViaBrowser(
  baseUrl: string,
  config: PublicConfig | undefined,
  waitMs = 45_000,
): Promise<BrowserMintResult> {
  // Check the shared browser session before asking the user to log in.
  const probeCtx = await getContext();
  const immediate = await tryLaunch(probeCtx, baseUrl, config);
  if (immediate) {
    await closeContext();
    return { status: "minted", token: immediate, detail: "existing browser session accepted" };
  }

  // No session: now a human has to see something.
  const ctx = await getContext();
  const loginUrl = `${baseUrl}/login/index.php`;
  let page: Page;
  if (loginPage && !loginPage.isClosed()) {
    page = loginPage;
  } else {
    page = await openPage();
    loginPage = page;
  }
  if (!page.url().startsWith(baseUrl)) {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  }
  await page.bringToFront().catch(() => {});

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const token = await tryLaunch(ctx, baseUrl, config);
    if (token) {
      await closePage({ page });
      loginPage = undefined;
      await closeContext();
      return { status: "minted", token, detail: "token minted after browser login" };
    }
  }

  return {
    status: "waiting",
    detail:
      "A Chrome tab is open on the Moodle login page. Finish logging in there (SSO included), then call moodle_connect again for the same URL — the token is picked up automatically." +
      (lastLaunchProblem ? `\nLast probe problem: ${lastLaunchProblem}` : ""),
  };
}

export interface ConnectPlan {
  config: PublicConfig;
  strategy: "password" | "mobile-launch" | "unsupported";
  reason: string;
}

export async function planConnection(baseUrl: string): Promise<ConnectPlan> {
  const config = await fetchPublicConfig(baseUrl);
  if (!config.enablewebservices || !config.enablemobilewebservice) {
    return {
      config,
      strategy: "unsupported",
      reason:
        "This site has the mobile web service switched off (enablemobilewebservice=0), so no token can be issued and this server cannot read it. A browser-automation MCP pointed straight at the site is the only route left.",
    };
  }
  if (config.typeoflogin === 1) {
    return {
      config,
      strategy: "password",
      reason: "Site accepts direct username/password token exchange (typeoflogin=1); no browser needed.",
    };
  }
  return {
    config,
    strategy: "mobile-launch",
    reason: `Site logs in via browser/SSO (typeoflogin=${config.typeoflogin}); token is minted through launch.php after you log in.`,
  };
}

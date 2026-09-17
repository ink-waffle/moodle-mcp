import type { Site } from "./config.js";

export class MoodleError extends Error {
  constructor(
    readonly errorcode: string,
    message: string,
    readonly fn: string,
  ) {
    super(`[${errorcode}] ${message}  (${fn})`);
    this.name = "MoodleError";
  }

  /** True when the stored token is dead and the user has to re-authenticate. */
  get needsReauth(): boolean {
    return ["invalidtoken", "accessexception", "invalidparameter:token"].includes(this.errorcode);
  }
}

export type Params = Record<string, unknown>;

/**
 * Moodle's REST server takes nested structures as flattened form keys:
 *   { courseids: [5, 9] } -> "courseids[0]=5&courseids[1]=9"
 *   { options: { onlyfetch: true } } -> "options[onlyfetch]=1"
 */
export function flattenParams(params: Params): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(`${prefix}[${k}]`, v);
    } else if (typeof value === "boolean") {
      out[prefix] = value ? "1" : "0";
    } else {
      out[prefix] = String(value);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out;
}

interface MoodleExceptionBody {
  exception?: string;
  errorcode?: string;
  message?: string;
}

/** Unauthenticated: every Moodle exposes this and it tells us how to log in. */
export interface PublicConfig {
  wwwroot: string;
  sitename: string;
  enablewebservices: number;
  enablemobilewebservice: number;
  /** 1 = username/password form, 2 = via browser (SSO), 3 = via embedded browser, 6 = via app */
  typeoflogin: number;
  launchurl?: string;
  identityproviders?: { name: string; url: string }[];
  tool_mobile_disabledfeatures?: string;
  maintenanceenabled?: number;
  showloginform?: number;
  lang?: string;
}

const USER_AGENT = "moodle-mcp/0.1";

async function postForm(url: string, body: Record<string, string>, timeoutMs = 45_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams(body).toString(),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a site's login configuration without any credentials.
 * service-nologin.php is the endpoint the Moodle app itself hits before login.
 */
export async function fetchPublicConfig(baseUrl: string): Promise<PublicConfig> {
  const url = `${baseUrl}/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify([{ index: 0, methodname: "tool_mobile_get_public_config", args: {} }]),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`${baseUrl} returned HTTP ${res.status} for the public-config probe. Is that the right Moodle URL?`);
  const body = (await res.json()) as { error?: unknown; data?: PublicConfig; exception?: MoodleExceptionBody }[];
  const first = body[0];
  if (!first || first.error || !first.data) {
    throw new Error(`${baseUrl} did not answer the public-config probe as a Moodle site would. Check the URL.`);
  }
  return first.data;
}

export class MoodleClient {
  constructor(readonly site: Site) {}

  get restUrl(): string {
    return `${this.site.url}/webservice/rest/server.php`;
  }

  async call<T = unknown>(fn: string, params: Params = {}): Promise<T> {
    const res = await postForm(this.restUrl, {
      wstoken: this.site.token,
      wsfunction: fn,
      moodlewsrestformat: "json",
      ...flattenParams(params),
    });
    if (!res.ok) throw new MoodleError("http_error", `HTTP ${res.status} ${res.statusText}`, fn);

    const text = await res.text();
    if (text.trim() === "" || text.trim() === "null") return null as T;

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new MoodleError("bad_response", `Response was not JSON: ${text.slice(0, 200)}`, fn);
    }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const err = data as MoodleExceptionBody;
      if (err.exception) throw new MoodleError(err.errorcode ?? "exception", err.message ?? "unknown error", fn);
    }
    return data as T;
  }

  /** Sign a pluginfile.php / webservice URL so it can be downloaded with the web-service token. */
  fileUrl(rawUrl: string): string {
    const u = new URL(rawUrl);
    u.searchParams.set("token", this.site.token);
    return u.toString();
  }

  async download(rawUrl: string): Promise<{ body: ArrayBuffer; mimetype: string; filename?: string }> {
    const res = await fetch(this.fileUrl(rawUrl), { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${rawUrl}`);
    const mimetype = res.headers.get("content-type") ?? "application/octet-stream";
    // Moodle answers with JSON (not a file) when the token is rejected.
    if (mimetype.includes("application/json")) {
      const err = (await res.json()) as MoodleExceptionBody;
      throw new MoodleError(err.errorcode ?? "download_error", err.message ?? "download rejected", "pluginfile");
    }
    const cd = res.headers.get("content-disposition") ?? "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    return {
      body: await res.arrayBuffer(),
      mimetype,
      filename: m?.[1] ? decodeURIComponent(m[1]) : undefined,
    };
  }
}

export interface SiteInfo {
  sitename: string;
  username: string;
  fullname: string;
  userid: number;
  release: string;
  siteurl: string;
  functions: { name: string; version: string }[];
  usercanmanageownfiles?: boolean;
}

export async function getSiteInfo(url: string, token: string): Promise<SiteInfo> {
  const client = new MoodleClient({
    key: "probe",
    url,
    token,
    userid: 0,
    strategy: "manual",
    connectedAt: "probe",
  });
  return client.call<SiteInfo>("core_webservice_get_site_info");
}

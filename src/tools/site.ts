import { mintTokenViaBrowser, mintTokenViaPassword, planConnection } from "../auth.js";
import {
  getSite,
  listSites,
  normalizeUrl,
  putSite,
  removeSite,
  siteKey,
  type Site,
} from "../config.js";
import { table } from "../format.js";
import { getSiteInfo, MoodleClient } from "../ws.js";

const KEY_FUNCTIONS: [string, string][] = [
  ["core_enrol_get_users_courses", "course list"],
  ["core_course_get_contents", "course structure + files"],
  ["core_course_get_course_module", "activity lookup by cmid"],
  ["mod_assign_get_assignments", "assignments"],
  ["mod_assign_get_submission_status", "submission state"],
  ["gradereport_user_get_grade_items", "per-course grades"],
  ["gradereport_overview_get_course_grades", "course totals"],
  ["core_calendar_get_action_events_by_timesort", "deadlines"],
  ["mod_forum_get_forums_by_courses", "forums"],
  ["mod_forum_get_discussion_posts", "forum posts"],
  ["core_message_get_conversations", "messages"],
  ["mod_quiz_get_quizzes_by_courses", "quizzes"],
];

function capabilityReport(functions: { name: string }[]): string {
  const have = new Set(functions.map((f) => f.name));
  const missing = KEY_FUNCTIONS.filter(([fn]) => !have.has(fn));
  const lines = [`${functions.length} web-service functions available.`];
  if (missing.length === 0) {
    lines.push("All features this server needs are present.");
  } else {
    lines.push(
      "Missing on this site (those tools will fail):",
      ...missing.map(([fn, what]) => `  - ${what} (${fn})`),
    );
  }
  return lines.join("\n");
}

export async function connect(opts: {
  url?: string;
  username?: string;
  password?: string;
  waitSeconds?: number;
}): Promise<string> {
  if (!opts.url) {
    const sites = await listSites();
    if (sites.length === 0) {
      throw new Error("Pass the Moodle URL to connect to, e.g. url: \"moodle.tuni.fi\".");
    }
    return status();
  }

  const url = normalizeUrl(opts.url);
  const plan = await planConnection(url);

  if (plan.strategy === "unsupported") {
    throw new Error(
      `${plan.config.sitename} (${url}) cannot issue tokens.\n${plan.reason}\nenablewebservices=${plan.config.enablewebservices}, enablemobilewebservice=${plan.config.enablemobilewebservice}`,
    );
  }

  let token: string;
  if (plan.strategy === "password") {
    if (!opts.username || !opts.password) {
      throw new Error(
        `${plan.config.sitename} uses a username/password login form (typeoflogin=1). Call moodle_connect again with username and password — they are exchanged for a token directly and never stored.`,
      );
    }
    token = (await mintTokenViaPassword(url, opts.username, opts.password)).token;
  } else {
    const result = await mintTokenViaBrowser(url, plan.config, Math.min((opts.waitSeconds ?? 45) * 1000, 120_000));
    if (result.status !== "minted" || !result.token) {
      const idps = plan.config.identityproviders?.map((i) => i.name).join(", ");
      return [
        `${plan.config.sitename} — ${plan.reason}`,
        idps ? `Identity providers offered: ${idps}` : "",
        "",
        result.detail,
      ]
        .filter(Boolean)
        .join("\n");
    }
    token = result.token.token;
  }

  const info = await getSiteInfo(url, token);
  const site: Site = {
    key: siteKey(url),
    url,
    token,
    userid: info.userid,
    username: info.username,
    sitename: info.sitename,
    release: info.release,
    strategy: plan.strategy === "password" ? "password" : "mobile-launch",
    connectedAt: new Date().toISOString(),
  };
  await putSite(site);

  return [
    `Connected to ${info.sitename} (${url})`,
    `as ${info.fullname} <${info.username}>, userid ${info.userid}, Moodle ${info.release}`,
    `auth: ${site.strategy} — token stored in ~/.moodle-mcp/config.json (mode 600)`,
    "",
    capabilityReport(info.functions),
    "",
    "Try moodle_courses next.",
  ].join("\n");
}

export async function status(): Promise<string> {
  const sites = await listSites();
  if (sites.length === 0) return "No Moodle site connected. Run moodle_connect with your Moodle URL.";

  const rows: (string | number)[][] = [];
  for (const s of sites) {
    let state = "ok";
    let who = s.username ?? "";
    try {
      const info = await getSiteInfo(s.url, s.token);
      who = `${info.fullname} <${info.username}>`;
    } catch (e) {
      state = `token rejected: ${(e as Error).message.slice(0, 60)}`;
    }
    rows.push([s.key, s.url, who, s.strategy, s.connectedAt.slice(0, 10), state]);
  }
  return `${table(["site", "url", "user", "auth", "since", "state"], rows)}\n\nA rejected token is fixed by running moodle_connect again for that URL.`;
}

export async function disconnect(siteRef: string): Promise<string> {
  const site = await getSite(siteRef);
  const ok = await removeSite(site.key);
  return ok
    ? `Removed ${site.key} from ~/.moodle-mcp/config.json. The token itself stays valid on the Moodle server until it expires or an admin resets it.`
    : `${siteRef} was not stored locally.`;
}

export async function clientFor(siteRef?: string): Promise<MoodleClient> {
  return new MoodleClient(await getSite(siteRef));
}

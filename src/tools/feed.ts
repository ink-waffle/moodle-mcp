import { cached, getCourses, getNotifications, getUpdatesSince, type CourseUpdate } from "../api.js";
import { fmtDate, fmtRelative, html2line, html2md, table } from "../format.js";
import type { MoodleClient } from "../ws.js";
import { courseSections, resolveCourse } from "./courses.js";

/**
 * Moodle's own notification feed. The only cross-course "what happened" channel
 * there is — forum posts, deadline reminders, grade notices all land here, so it
 * answers in one call what otherwise takes a crawl of every course and forum.
 */
export async function notifications(
  client: MoodleClient,
  opts: { limit?: number; unreadOnly?: boolean; full?: boolean } = {},
): Promise<string> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const { notifications: all, unreadcount } = await getNotifications(client, limit);
  const rows = opts.unreadOnly ? all.filter((n) => !n.read) : all;

  if (rows.length === 0) {
    return `No notifications${opts.unreadOnly ? " unread" : ""} (${unreadcount} unread in total).`;
  }

  if (opts.full) {
    const out = [`${rows.length} notification(s), ${unreadcount} unread\n`];
    for (const n of rows) {
      out.push(
        `## ${n.read ? "" : "● "}${n.subject}`,
        `${fmtDate(n.timecreated)} (${fmtRelative(n.timecreated)}) · ${n.component}/${n.eventtype}`,
        n.contexturl ? `→ ${n.contexturl}` : "",
        "",
        html2md(n.fullmessagehtml || n.fullmessage, 3000),
        "",
      );
    }
    return out.filter((l) => l !== "").join("\n");
  }

  const body = table(
    ["", "when", "source", "subject", "link"],
    rows.map((n) => [
      n.read ? "" : "●",
      `${fmtDate(n.timecreated)} (${fmtRelative(n.timecreated)})`,
      n.component.replace(/^mod_/, ""),
      html2line(n.subject, 90),
      n.contexturl || "",
    ]),
  );
  return `${rows.length} notification(s), ${unreadcount} unread (● = unread)\n\n${body}\n\nAdd full:true to read the message bodies.`;
}

/**
 * What changed in a course since a point in time. Also the cheap freshness probe
 * behind the course-contents cache — see courseSections().
 */
export async function whatsNew(
  client: MoodleClient,
  opts: { course?: string | number; days?: number } = {},
): Promise<string> {
  const days = opts.days ?? 7;
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const targets = opts.course !== undefined
    ? [await resolveCourse(client, opts.course)]
    : (await cached(client, "courses", () => getCourses(client))).filter(
        (c) => (!c.enddate || c.enddate * 1000 > Date.now()) && (!c.startdate || c.startdate * 1000 < Date.now()),
      );

  const lines: string[] = [];
  let total = 0;
  for (const course of targets) {
    let updates: CourseUpdate[];
    try {
      updates = await getUpdatesSince(client, course.id, since);
    } catch (e) {
      lines.push(`- **${course.shortname}** — could not check (${(e as Error).message})`);
      continue;
    }
    const modules = updates.filter((u) => u.contextlevel === "module");
    if (modules.length === 0) continue;
    total += modules.length;

    // Name the cmids from the cached course structure rather than a call each.
    const names = new Map<number, string>();
    try {
      for (const s of await courseSections(client, course.id)) {
        for (const m of s.modules) names.set(m.id, `${m.modname} "${m.name}"`);
      }
    } catch {
      /* names are a nicety */
    }

    lines.push(`\n### ${course.shortname} — ${modules.length} activity/activities changed`);
    lines.push(
      table(
        ["cmid", "activity", "what changed"],
        modules.map((u) => [
          u.id,
          names.get(u.id) ?? "(not in course contents)",
          u.updates
            .map((x) => `${x.name}${x.itemids?.length ? ` ×${x.itemids.length}` : ""}`)
            .join(", "),
        ]),
      ),
    );
  }

  if (total === 0) {
    return `Nothing changed in ${targets.length} course(s) in the last ${days} day(s).`;
  }
  return `${total} activity change(s) across ${targets.length} course(s), last ${days} day(s):${lines.join("\n")}\n\nmoodle_activity(cmid) shows what an activity looks like now.`;
}

import { cached, getActionEvents, getCourseGradesOverview, getCourses, getGradeItems } from "../api.js";
import { decodeEntities, fmtDate, fmtRelative, html2line, table } from "../format.js";
import type { MoodleClient } from "../ws.js";
import { resolveCourse } from "./courses.js";

export async function deadlines(
  client: MoodleClient,
  opts: { days?: number; overdueDays?: number; course?: string | number; limit?: number } = {},
): Promise<string> {
  const { days = 30, overdueDays = 21 } = opts;
  // core_calendar_get_action_events_by_timesort rejects limitnum outside 1..50.
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 50);
  const now = Math.floor(Date.now() / 1000);
  const events = await getActionEvents(client, now - overdueDays * 86400, now + days * 86400, limit);

  // Moodle emits several events for one activity ("Quiz closes" + "Quiz requires
  // action" at the same timestamp). Keep the actionable one, note the rest.
  const merged = new Map<string, (typeof events)[number] & { alsoLabelled?: string[] }>();
  for (const e of events) {
    const key = `${e.course?.id ?? 0}-${e.modulename ?? e.eventtype}-${e.instance}-${e.timesort}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...e });
    } else if (!prev.action?.actionable && e.action?.actionable) {
      merged.set(key, { ...e, alsoLabelled: [...(prev.alsoLabelled ?? []), prev.activitystr ?? prev.eventtype] });
    } else if (e.activitystr && e.activitystr !== prev.activitystr) {
      prev.alsoLabelled = [...(prev.alsoLabelled ?? []), e.activitystr];
    }
  }

  let filtered = [...merged.values()].sort((a, b) => a.timesort - b.timesort);
  if (opts.course !== undefined) {
    const course = await resolveCourse(client, opts.course);
    filtered = filtered.filter((e) => e.course?.id === course.id);
  }
  if (filtered.length === 0) {
    return `Nothing actionable between ${fmtDate(now - overdueDays * 86400)} and ${fmtDate(now + days * 86400)}. Moodle only lists an event here while it still needs action, so submitted work drops off this list.`;
  }

  const body = table(
    ["due", "when", "course", "activity", "what", "cmid"],
    filtered.map((e) => [
      fmtDate(e.timesort),
      (e.timesort < now ? "OVERDUE " : "") + fmtRelative(e.timesort),
      e.course?.shortname ?? "",
      e.activityname ?? e.name,
      `${e.activitystr ?? e.eventtype}${e.action?.name ? ` → ${e.action.name}` : ""}${e.alsoLabelled?.length ? ` (+${e.alsoLabelled.length} more event${e.alsoLabelled.length === 1 ? "" : "s"})` : ""}`,
      e.modulename ? e.instance : "",
    ]),
  );
  return `${filtered.length} actionable item(s), ${fmtDate(now - overdueDays * 86400)} → ${fmtDate(now + days * 86400)}:\n\n${body}\n\nThe cmid column feeds moodle_activity / moodle_download.`;
}

export async function grades(client: MoodleClient, course?: string | number): Promise<string> {
  if (course === undefined) {
    const [overview, courses] = await Promise.all([
      getCourseGradesOverview(client),
      cached(client, "courses", () => getCourses(client)),
    ]);
    const names = new Map(courses.map((c) => [c.id, c.shortname]));
    const rows = overview
      .filter((g) => names.has(g.courseid))
      .map((g) => [g.courseid, names.get(g.courseid) ?? "", g.grade === "-" ? "" : g.grade]);
    return `Course totals on ${client.site.key} (blank = nothing graded yet):\n\n${table(["courseid", "course", "total"], rows)}\n\nPass a course to see its individual grade items.`;
  }

  const resolved = await resolveCourse(client, course);
  const items = await getGradeItems(client, resolved.id);
  if (items.length === 0) {
    return `No grade items visible in ${resolved.shortname} (id ${resolved.id}). The teacher may have hidden the gradebook.`;
  }
  const label = (it: (typeof items)[number]) =>
    // itemname is "" (not null) on the aggregate rows Moodle inserts per category.
    it.itemname || (it.itemtype === "course" ? "COURSE TOTAL" : it.itemtype === "category" ? "— category total" : it.itemtype);
  const rows = items.map((it) => [
    label(it),
    it.gradeformatted === "-" ? "" : it.gradeformatted,
    decodeEntities(it.rangeformatted ?? ""),
    it.percentageformatted === "-" ? "" : it.percentageformatted,
    decodeEntities(it.weightformatted ?? ""),
    it.cmid ?? "",
    html2line(it.feedback, 120),
  ]);
  const graded = items.filter((i) => i.graderaw !== null && i.itemtype !== "course").length;
  return `# ${resolved.fullname}\ngrades for ${items.length} item(s), ${graded} graded so far\n\n${table(["item", "grade", "range", "%", "weight", "cmid", "feedback"], rows)}`;
}

import {
  cached,
  getAssignments,
  getCourseContents,
  getCourses,
  getUpdatesSince,
  type Course,
  type CourseSection,
} from "../api.js";
import { dateLabel, decodeEntities, fmtDate, fmtSize, html2line, html2md, table } from "../format.js";
import type { MoodleClient } from "../ws.js";

export type CourseFilter = "active" | "all" | "past" | "future" | "favourites";

function classify(c: Course, now: number): "active" | "past" | "future" {
  if (c.enddate && c.enddate * 1000 < now) return "past";
  if (c.startdate && c.startdate * 1000 > now) return "future";
  return "active";
}

export async function coursesList(
  client: MoodleClient,
  filter: CourseFilter = "active",
  refresh = false,
): Promise<string> {
  const all = await cached(client, "courses", () => getCourses(client), { refresh });
  const now = Date.now();
  const rows = all
    .filter((c) => {
      if (filter === "all") return true;
      if (filter === "favourites") return c.isfavourite;
      return classify(c, now) === filter;
    })
    .sort((a, b) => (b.startdate || 0) - (a.startdate || 0));

  if (rows.length === 0) {
    return `No courses match filter "${filter}" (${all.length} enrolments total). Try filter:"all".`;
  }

  const body = table(
    ["id", "shortname", "name", "starts", "ends", "state", "progress"],
    rows.map((c) => [
      c.id,
      c.shortname,
      c.fullname,
      fmtDate(c.startdate),
      fmtDate(c.enddate),
      classify(c, now) + (c.hidden ? ", hidden" : ""),
      c.progress === null ? "" : `${Math.round(c.progress)}%`,
    ]),
  );
  return `${rows.length} of ${all.length} enrolments (filter: ${filter}) on ${client.site.key}\n\n${body}\n\nUse the id with moodle_outline to see a course's structure.`;
}

export async function resolveCourse(client: MoodleClient, ref: string | number): Promise<Course> {
  const all = await cached(client, "courses", () => getCourses(client));
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
    const id = Number(ref);
    const byId = all.find((c) => c.id === id);
    if (byId) return byId;
    // Not enrolled-visible but maybe still readable; synthesise a stub.
    return {
      id,
      shortname: `course-${id}`,
      fullname: `course ${id}`,
      startdate: 0,
      enddate: 0,
      visible: 1,
      hidden: 0,
      isfavourite: false,
      progress: null,
      completed: null,
      enablecompletion: false,
      lastaccess: null,
      category: 0,
      summary: "",
    };
  }
  const needle = String(ref).toLowerCase();
  const matches = all.filter(
    (c) => c.shortname.toLowerCase().includes(needle) || c.fullname.toLowerCase().includes(needle),
  );
  if (matches.length === 0) throw new Error(`No enrolled course matches "${ref}". Run moodle_courses to list them.`);
  if (matches.length > 1) {
    const opts = matches.map((c) => `${c.id} ${c.shortname}`).join("; ");
    throw new Error(`"${ref}" matches several courses — pass an id: ${opts}`);
  }
  return matches[0]!;
}

const CONTENTS_HARD_REFRESH_S = 6 * 3600;

export async function courseSections(
  client: MoodleClient,
  courseid: number,
  refresh = false,
): Promise<CourseSection[]> {
  return cached(client, `contents-${courseid}`, () => getCourseContents(client, courseid), {
    refresh,
    // Past the TTL, ask Moodle what changed instead of refetching the whole course:
    // one small call replaces a payload that runs to tens of KB. A hard ceiling
    // still forces a full refetch periodically, since updates_since only reports
    // module-level changes and would miss, say, a renamed section.
    validate: async (cachedAt) => {
      if (Math.floor(Date.now() / 1000) - cachedAt > CONTENTS_HARD_REFRESH_S) return false;
      return (await getUpdatesSince(client, courseid, cachedAt)).length === 0;
    },
  });
}

export interface OutlineOpts {
  sections?: number[];
  descriptions?: boolean;
  files?: boolean;
  maxDescChars?: number;
  refresh?: boolean;
}

export async function courseOutline(
  client: MoodleClient,
  ref: string | number,
  opts: OutlineOpts = {},
): Promise<string> {
  const { descriptions = true, files = true, maxDescChars = 2000, refresh = false } = opts;
  const course = await resolveCourse(client, ref);
  const sections = await courseSections(client, course.id, refresh);

  const head = [
    `# ${course.fullname}`,
    [
      `course id ${course.id}`,
      course.shortname,
      course.startdate ? `${fmtDate(course.startdate)} → ${fmtDate(course.enddate)}` : null,
      course.progress === null ? null : `progress ${Math.round(course.progress)}%`,
    ]
      .filter(Boolean)
      .join(" · "),
  ];
  if (course.summary) head.push("", html2md(course.summary, 800));

  const out: string[] = [head.join("\n")];

  // A "subsection" activity is a pointer to another section further down the list.
  const delegated = new Map<number, number>();
  for (const s of sections) {
    if (s.component && s.itemid) delegated.set(s.itemid, s.section);
  }

  for (const s of sections) {
    if (opts.sections && !opts.sections.includes(s.section)) continue;
    if (s.modules.length === 0 && !s.summary) continue;
    out.push(`\n## §${s.section} ${decodeEntities(s.name)}${s.visible === 0 ? " [hidden]" : ""}`);
    if (s.summary && descriptions) {
      const md = html2md(s.summary, 800);
      if (md) out.push(md.replace(/^/gm, "> "));
    }
    for (const m of s.modules) {
      const bits = [`cmid ${m.id}`];
      for (const d of m.dates ?? []) bits.push(`${dateLabel(d)} ${fmtDate(d.timestamp)}`);
      if (m.completiondata && m.completion > 0) {
        bits.push(m.completiondata.state > 0 ? "done" : "not done");
      }
      if (m.visible === 0) bits.push("hidden");
      if (!m.uservisible) bits.push("restricted");
      if (m.contentsinfo?.filescount) {
        bits.push(`${m.contentsinfo.filescount} file${m.contentsinfo.filescount === 1 ? "" : "s"}`);
      }
      const target = delegated.get(m.instance);
      if (target !== undefined) bits.push(`contents in §${target}`);
      const title = m.name && m.name !== "" ? `**${m.name}**` : "";
      out.push(`- \`${m.modname}\` ${title} · ${bits.join(" · ")}`);

      if (m.availabilityinfo) out.push(`  - access: ${html2line(m.availabilityinfo, 200)}`);
      if (descriptions && m.description) {
        const md = html2md(m.description, maxDescChars);
        if (md) out.push(md.replace(/^/gm, "  > "));
      }
      if (files) {
        for (const c of m.contents ?? []) {
          if (c.type === "file") out.push(`  - file: ${c.filename} (${fmtSize(c.filesize)})`);
          else if (c.type === "url") out.push(`  - link: ${c.fileurl}`);
        }
      }
    }
  }

  out.push(
    "",
    "moodle_activity(cmid) for one activity in full · moodle_download(cmid) to fetch its files · moodle_deadlines for what is due.",
  );
  return out.join("\n");
}

/* ---------- client-side search (Moodle's global search is often disabled) ---------- */

export interface SearchHit {
  course: string;
  courseid: number;
  where: string;
  cmid?: number;
  snippet: string;
}

export async function searchCourses(
  client: MoodleClient,
  query: string,
  opts: { courses?: (string | number)[]; includeAssignments?: boolean; limit?: number; refresh?: boolean } = {},
): Promise<string> {
  const { includeAssignments = true, limit = 40, refresh = false } = opts;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) throw new Error("Empty query.");

  let targets: Course[];
  if (opts.courses?.length) {
    targets = await Promise.all(opts.courses.map((c) => resolveCourse(client, c)));
  } else {
    const all = await cached(client, "courses", () => getCourses(client), { refresh });
    const now = Date.now();
    targets = all.filter((c) => !c.enddate || c.enddate * 1000 > now - 180 * 86400 * 1000);
  }

  const matches = (text: string) => {
    const t = text.toLowerCase();
    return terms.every((term) => t.includes(term));
  };
  const snippet = (text: string) => {
    const t = text.replace(/\s+/g, " ");
    const i = t.toLowerCase().indexOf(terms[0]!);
    const start = Math.max(0, i - 90);
    return `${start > 0 ? "…" : ""}${t.slice(start, start + 240)}${t.length > start + 240 ? "…" : ""}`;
  };

  const hits: SearchHit[] = [];
  for (const course of targets) {
    let sections: CourseSection[];
    try {
      sections = await courseSections(client, course.id, refresh);
    } catch {
      continue;
    }
    for (const s of sections) {
      const sectionText = `${s.name} ${html2md(s.summary, 8000)}`;
      if (matches(sectionText)) {
        hits.push({ course: course.shortname, courseid: course.id, where: `§${s.section} ${decodeEntities(s.name)}`, snippet: snippet(sectionText) });
      }
      for (const m of s.modules) {
        const body = html2md(m.description, 20_000);
        const fileNames = (m.contents ?? []).map((c) => c.filename).join(" ");
        const text = `${m.name} ${body} ${fileNames}`;
        if (matches(text)) {
          hits.push({
            course: course.shortname,
            courseid: course.id,
            where: `${m.modname} "${m.name}" §${s.section}`,
            cmid: m.id,
            snippet: snippet(text),
          });
        }
      }
    }
    if (includeAssignments) {
      try {
        const assigns = await cached(client, `assigns-${course.id}`, () => getAssignments(client, [course.id]), {
          refresh,
        });
        for (const a of assigns) {
          const text = `${a.name} ${html2md(a.intro, 20_000)}`;
          if (matches(text) && !hits.some((h) => h.cmid === a.cmid)) {
            hits.push({
              course: course.shortname,
              courseid: course.id,
              where: `assign "${a.name}"`,
              cmid: a.cmid,
              snippet: snippet(text),
            });
          }
        }
      } catch {
        /* course may have no assign module or no permission */
      }
    }
  }

  if (hits.length === 0) {
    return `No match for "${query}" across ${targets.length} course(s). Searched section names/summaries, activity names, descriptions, file names${includeAssignments ? " and assignment descriptions" : ""}.`;
  }
  const shown = hits.slice(0, limit);
  const body = shown
    .map((h) => `- **${h.course}** · ${h.where}${h.cmid ? ` · cmid ${h.cmid}` : ""}\n  ${h.snippet}`)
    .join("\n");
  return `${hits.length} match(es) for "${query}"${hits.length > shown.length ? `, showing ${shown.length}` : ""}:\n\n${body}`;
}

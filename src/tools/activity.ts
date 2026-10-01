import {
  cached,
  getAssignments,
  getCourseModuleInfo,
  getDiscussions,
  getForums,
  getModInstances,
  getSubmissionStatus,
  getWorkshopGrades,
  getWorkshopReviewerAssessments,
  getWorkshopSubmissionAssessments,
  getWorkshopSubmissions,
  type CourseModule,
  type ModuleContent,
} from "../api.js";
import { dateLabel, decodeEntities, fmtDate, fmtRelative, fmtSize, html2line, html2md, table } from "../format.js";
import { MoodleError, type MoodleClient } from "../ws.js";
import { courseSections } from "./courses.js";

/** modname -> the plural used by `mod_<name>_get_<plural>_by_courses`. */
const PLURALS: Record<string, string> = {
  assign: "assignments",
  bigbluebuttonbn: "bigbluebuttonbns",
  book: "books",
  chat: "chats",
  choice: "choices",
  data: "databases",
  feedback: "feedbacks",
  folder: "folders",
  forum: "forums",
  glossary: "glossaries",
  h5pactivity: "h5pactivities",
  imscp: "imscps",
  label: "labels",
  lesson: "lessons",
  lti: "ltis",
  page: "pages",
  quiz: "quizzes",
  resource: "resources",
  scorm: "scorms",
  survey: "surveys",
  url: "urls",
  wiki: "wikis",
  workshop: "workshops",
};

interface WithCm {
  id: number;
  coursemodule: number;
  name?: string;
  intro?: string;
  content?: string;
  [k: string]: unknown;
}

const CORE_QUIZ_QTYPES = new Set([
  "calculated", "calculatedmulti", "calculatedsimple", "ddimageortext", "ddmarker", "ddwtos",
  "description", "essay", "gapselect", "match", "multianswer", "multichoice", "numerical",
  "ordering", "random", "randomsamatch", "shortanswer", "truefalse",
]);

const DATE_KEYS = [
  "timeopen",
  "timeclose",
  "duedate",
  "cutoffdate",
  "allowsubmissionsfromdate",
  "submissionstart",
  "submissionend",
  "assessmentstart",
  "assessmentend",
  "timeavailablefrom",
  "timeavailableto",
  "available",
  "deadline",
  "timelimit",
];

function filesBlock(contents: ModuleContent[] | undefined, cmid: number): string[] {
  const files = (contents ?? []).filter((c) => c.type === "file");
  const links = (contents ?? []).filter((c) => c.type === "url");
  const out: string[] = [];
  if (files.length) {
    out.push("", "### Files");
    out.push(table(["filename", "size", "modified"], files.map((f) => [f.filename, fmtSize(f.filesize), fmtDate(f.timemodified)])));
    out.push(`\nmoodle_download({ cmid: ${cmid} }) saves all of them locally.`);
  }
  if (links.length) {
    out.push("", "### Links");
    for (const l of links) out.push(`- ${l.fileurl}`);
  }
  return out;
}

function genericFields(inst: WithCm): string[] {
  const out: string[] = [];
  const dates = DATE_KEYS.filter((k) => typeof inst[k] === "number" && (inst[k] as number) > 0).map(
    (k) => `${k} ${fmtDate(inst[k] as number)} (${fmtRelative(inst[k] as number)})`,
  );
  if (dates.length) out.push(`- dates: ${dates.join(" · ")}`);
  return out;
}

async function assignDetail(client: MoodleClient, cm: { course: number; instance: number; id: number }): Promise<string[]> {
  const assigns = await cached(client, `assigns-${cm.course}`, () => getAssignments(client, [cm.course]));
  const a = assigns.find((x) => x.cmid === cm.id) ?? assigns.find((x) => x.id === cm.instance);
  if (!a) return ["(assignment metadata not returned by the site)"];

  const out: string[] = [];
  out.push(
    table(
      ["field", "value"],
      [
        ["opens", `${fmtDate(a.allowsubmissionsfromdate)}`],
        ["due", `${fmtDate(a.duedate)} ${fmtRelative(a.duedate)}`],
        ["hard cutoff", fmtDate(a.cutoffdate)],
        ["max grade", a.grade],
        ["attempts allowed", a.maxattempts === -1 ? "unlimited" : a.maxattempts],
        ["group submission", a.teamsubmission ? "yes" : "no"],
        ["draft before final submit", a.submissiondrafts ? "yes" : "no"],
        ["submission statement required", a.requiresubmissionstatement ? "yes" : "no"],
      ],
    ),
  );

  const fileTypes = a.configs?.find((c) => c.plugin === "file" && c.name === "filetypeslist")?.value;
  const maxFiles = a.configs?.find((c) => c.plugin === "file" && c.name === "maxfilesubmissions")?.value;
  if (fileTypes || maxFiles) {
    out.push("", `Submission: ${maxFiles ? `up to ${maxFiles} file(s)` : ""}${fileTypes ? ` restricted to ${fileTypes}` : ""}`);
  }
  const enabled = a.configs?.filter((c) => c.subtype === "assignsubmission" && c.name === "enabled" && c.value === "1")
    .map((c) => c.plugin) ?? [];
  if (enabled.length) out.push(`Submission plugins: ${enabled.join(", ")}`);
  const unsupported = enabled.filter((plugin) => !["file", "onlinetext", "comments"].includes(plugin));
  if (unsupported.length) {
    out.push(`**Plugin limitation:** ${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} outside this server's assignment-submit tool. Inspect the activity in Moodle before submitting; other required fields may need its UI.`);
  }
  if (a.submissionstatement) out.push("", "### Submission statement", html2md(a.submissionstatement, 2000));
  if (a.requiresubmissionstatement && !a.submissiondrafts) {
    out.push("", "**Moodle UI required:** This assignment requires accepting a submission statement, but the no-draft save API cannot record acceptance. Use the activity link in a browser; ask the student to submit or use a separate browser tool only if appropriate.");
  }

  const intro = html2md(a.intro, 8000);
  if (intro) out.push("", "### Description", intro);

  const attachments = [...(a.introattachments ?? []), ...(a.introfiles ?? [])];
  if (attachments.length) {
    out.push("", "### Attached task files");
    out.push(table(["filename", "size"], attachments.map((f) => [f.filename, fmtSize(f.filesize)])));
    out.push(`\nmoodle_download({ cmid: ${cm.id} }) fetches these.`);
  }

  try {
    const st = await getSubmissionStatus(client, a.id);
    const la = st.lastattempt;
    const rows: (string | number)[][] = [
      ["submission status", la?.submission?.status ?? la?.teamsubmission?.status ?? "none"],
      ["grading status", la?.gradingstatus ?? "—"],
      ["can finalize draft", la?.cansubmit ? "yes" : "no"],
      ["can save or edit", la?.submissionsenabled && la.canedit ? "yes" : "no"],
    ];
    if (la?.submission?.timemodified) rows.push(["last change", fmtDate(la.submission.timemodified)]);
    if (la?.extensionduedate) rows.push(["extension until", fmtDate(la.extensionduedate)]);
    if (st.feedback?.gradefordisplay) rows.push(["grade", html2line(st.feedback.gradefordisplay, 80)]);
    out.push("", "### Your submission", table(["field", "value"], rows));
  } catch (e) {
    out.push("", `(submission status unavailable: ${(e as Error).message})`);
  }
  return out;
}

async function quizDetail(
  client: MoodleClient,
  cm: { course: number; id: number },
  reviewAttempt?: number,
): Promise<string[]> {
  const quizzes = await getModInstances<WithCm>(client, "quiz", "quizzes", cm.course);
  const q = quizzes.find((x) => x.coursemodule === cm.id);
  if (!q) return ["(quiz metadata not returned by the site)"];
  const out: string[] = [...genericFields(q)];
  const intro = html2md(q.intro as string, 4000);
  if (intro) out.push("", "### Description", intro);

  out.push("", "**Quiz interaction limit:** The API returns rendered HTML, not a complete visual or interactive view. Even standard question types can include images, media or site-specific scripts. Inspect the actual page before answering; use a separate browser tool or ask the student when its content cannot be understood from the API. Question-type checks cannot rule this out.");
  try {
    const types = await client.call<{ questiontypes: string[]; warnings?: { message?: string }[] }>(
      "mod_quiz_get_quiz_required_qtypes", { quizid: q.id },
    );
    if (types.warnings?.length) {
      out.push(`Question types could not be determined: ${types.warnings.map((w) => w.message ?? "Moodle warning").join("; ")}`);
    } else {
      out.push(`Question types reported by Moodle: ${types.questiontypes.join(", ") || "none"}.`);
      const unfamiliar = types.questiontypes.filter((type) => !CORE_QUIZ_QTYPES.has(type));
      if (unfamiliar.length) {
        out.push(`**Browser likely needed:** ${unfamiliar.join(", ")} ${unfamiliar.length === 1 ? "is" : "are"} not among Moodle 4.5's bundled question types. Do not assume raw API fields are enough to interact with these questions.`);
      }
    }
  } catch {
    out.push("Question types unavailable; browser-dependent questions cannot be ruled out.");
  }

  try {
    const access = await client.call<{ preventaccessreasons: string[]; canattempt: boolean; activerulenames: string[] }>(
      "mod_quiz_get_quiz_access_information",
      { quizid: q.id },
    );
    out.push(
      "",
      `Can attempt: ${access.canattempt ? "yes" : "no"}${access.preventaccessreasons?.length ? ` — ${access.preventaccessreasons.join("; ")}` : ""}`,
    );
  } catch {
    /* optional */
  }
  try {
    const att = await client.call<{ attempts: { id: number; attempt: number; state: string; timestart: number; timefinish: number; sumgrades: number | null }[] }>(
      "mod_quiz_get_user_attempts",
      { quizid: q.id, status: "all" },
    );
    if (att.attempts?.length) {
      out.push(
        "",
        "### Your attempts",
        table(
          ["id", "#", "state", "started", "finished", "sumgrades"],
          att.attempts.map((a) => [a.id, a.attempt, a.state, fmtDate(a.timestart), fmtDate(a.timefinish), a.sumgrades ?? ""]),
        ),
      );
    } else {
      out.push("", "No attempts yet.");
    }
    const best = await client.call<{ hasgrade: boolean; grade?: number }>("mod_quiz_get_user_best_grade", {
      quizid: q.id,
    });
    if (best.hasgrade) out.push(`Best grade: ${best.grade}`);

    if (att.attempts?.length) {
      const finished = att.attempts.filter((a) => a.state === "finished");
      if (reviewAttempt === undefined && finished.length) {
        out.push(
          "",
          `Pass attempt:<n> to read a finished attempt's questions, answers and feedback (finished: ${finished.map((a) => a.attempt).join(", ")}).`,
        );
      }
      if (reviewAttempt !== undefined) {
        const target = att.attempts.find((a) => a.attempt === reviewAttempt);
        if (!target) {
          out.push("", `No attempt #${reviewAttempt} on this quiz.`);
        } else {
          out.push(...(await quizAttemptReview(client, target.id, reviewAttempt)));
        }
      }
    }
  } catch {
    /* optional */
  }
  return out;
}

interface ReviewQuestion {
  slot: number;
  number?: number;
  type: string;
  status: string;
  state?: string;
  flagged?: boolean;
  mark?: string;
  maxmark?: number;
  html: string;
}

/**
 * Quiz questions are only ever server-rendered HTML — there is no structured
 * form of the question, the answer or the feedback anywhere in the API — so the
 * best available move is to strip the markup and keep the text.
 * Not exercised live: the test account had no finished attempts.
 */
async function quizAttemptReview(client: MoodleClient, attemptid: number, n: number): Promise<string[]> {
  try {
    const rev = await client.call<{
      grade: string;
      attempt: { state: string; sumgrades: number | null; timefinish: number };
      questions: ReviewQuestion[];
      additionaldata?: { title: string; content: string }[];
    }>("mod_quiz_get_attempt_review", { attemptid, page: -1 });

    const out = [
      "",
      `### Attempt #${n} review`,
      `state ${rev.attempt?.state ?? "?"} · finished ${fmtDate(rev.attempt?.timefinish)} · grade ${rev.grade ?? "—"} · sumgrades ${rev.attempt?.sumgrades ?? "—"}`,
    ];
    for (const d of rev.additionaldata ?? []) {
      const c = html2line(d.content, 300);
      if (c) out.push(`- **${d.title}**: ${c}`);
    }
    for (const q of rev.questions ?? []) {
      out.push(
        "",
        `#### Q${q.number ?? q.slot} · ${q.type} · ${q.status}${q.mark !== undefined ? ` · ${q.mark}/${q.maxmark}` : ""}${q.flagged ? " · flagged" : ""}`,
      );
      const body = html2md(q.html, 3000);
      if (body) out.push(body);
    }
    return out;
  } catch (e) {
    const msg = (e as Error).message;
    return [
      "",
      /noreview/i.test(msg)
        ? `Attempt #${n} cannot be reviewed — the quiz's review options hide it (\`noreview\`).`
        : `Attempt #${n} review unavailable: ${msg}`,
    ];
  }
}

async function forumDetail(client: MoodleClient, cm: { course: number; id: number }): Promise<string[]> {
  const forums = await getForums(client, [cm.course]);
  const f = forums.find((x) => x.cmid === cm.id);
  if (!f) return ["(forum metadata not returned by the site)"];
  const out: string[] = [`- forum id ${f.id} · type ${f.type} · ${f.numdiscussions} discussion(s)${f.unreadpostscount ? ` · ${f.unreadpostscount} unread` : ""}`];
  const intro = html2md(f.intro, 2000);
  if (intro) out.push("", intro);
  try {
    const discussions = await getDiscussions(client, f.id, 15);
    if (discussions.length) {
      out.push(
        "",
        "### Latest discussions",
        table(
          ["discussion id", "subject", "by", "last activity", "replies"],
          discussions.map((d) => [d.discussion, d.subject, d.userfullname, fmtDate(d.modified), d.numreplies]),
        ),
        `\nmoodle_forum({ discussion: <id> }) reads a thread's posts.`,
      );
    }
  } catch (e) {
    out.push("", `(discussions unavailable: ${(e as Error).message})`);
  }
  return out;
}

async function choiceDetail(client: MoodleClient, cm: { course: number; id: number }): Promise<string[]> {
  const choices = await getModInstances<WithCm>(client, "choice", "choices", cm.course);
  const c = choices.find((x) => x.coursemodule === cm.id);
  if (!c) return ["(choice metadata not returned by the site)"];
  const out: string[] = [...genericFields(c)];
  const intro = html2md(c.intro as string, 3000);
  if (intro) out.push("", "### Description", intro);
  try {
    const res = await client.call<{ options: { id: number; text: string; maxanswers: number; countanswers: number; disabled: boolean; checked: boolean }[] }>(
      "mod_choice_get_choice_options",
      { choiceid: c.id },
    );
    out.push(
      "",
      "### Options",
      table(
        ["id", "option", "taken", "capacity", "yours", "closed"],
        res.options.map((o) => [
          o.id,
          decodeEntities(o.text),
          o.countanswers,
          o.maxanswers || "∞",
          o.checked ? "✓" : "",
          o.disabled ? "yes" : "",
        ]),
      ),
    );
  } catch (e) {
    out.push("", `(options unavailable: ${(e as Error).message})`);
  }
  return out;
}

async function workshopDetail(client: MoodleClient, cm: { course: number; id: number }): Promise<string[]> {
  const workshops = await getModInstances<WithCm>(client, "workshop", "workshops", cm.course);
  const w = workshops.find((x) => x.coursemodule === cm.id);
  if (!w) return ["(workshop metadata not returned by the site)"];
  const out: string[] = [...genericFields(w), `- phase code: ${w.phase ?? "?"}`];
  const intro = html2md(w.intro as string, 4000);
  if (intro) out.push("", "### Description", intro);
  if (typeof w.instructauthors === "string" && w.instructauthors) {
    out.push("", "### Instructions for submission", html2md(w.instructauthors, 4000));
  }
  if (typeof w.instructreviewers === "string" && w.instructreviewers) {
    out.push("", "### Instructions for assessment", html2md(w.instructreviewers, 4000));
  }
  try {
    const plan = await client.call<{ userplan: { phases: { title: string; active: boolean; tasks: { title: string; completed: string }[] }[] } }>(
      "mod_workshop_get_user_plan",
      { workshopid: w.id },
    );
    out.push("", "### Your plan");
    for (const p of plan.userplan.phases) {
      out.push(`- ${p.active ? "**" : ""}${p.title}${p.active ? "** (current)" : ""}`);
      for (const t of p.tasks ?? []) out.push(`  - [${t.completed === "1" ? "x" : " "}] ${html2line(t.title, 120)}`);
    }
  } catch {
    /* optional */
  }

  // Peer review is the point of a workshop: your submission, the reviews you got,
  // the reviews you wrote, and the two grades those produce.
  try {
    const mine = await getWorkshopSubmissions(client, w.id);
    if (mine.length === 0) {
      out.push("", "### Your submission", "Nothing submitted.");
    } else {
      for (const sub of mine) {
        out.push(
          "",
          `### Your submission — "${sub.title}"`,
          `submitted ${fmtDate(sub.timecreated)}${sub.timemodified !== sub.timecreated ? `, edited ${fmtDate(sub.timemodified)}` : ""}`,
        );
        const body = html2md(sub.content, 2000);
        if (body) out.push("", body);
        const files = [...(sub.attachmentfiles ?? []), ...(sub.contentfiles ?? [])];
        if (files.length) {
          out.push("", table(["file", "size"], files.map((f) => [f.filename, fmtSize(f.filesize)])));
        }
        const received = await getWorkshopSubmissionAssessments(client, sub.id).catch(() => []);
        if (received.length) {
          out.push("", `#### Reviews you received (${received.length})`);
          for (const a of received) {
            out.push(
              `- grade ${a.grade ?? "—"}${a.weight !== 1 ? ` (weight ${a.weight})` : ""} · ${fmtDate(a.timecreated)}`,
            );
            const fb = html2md(a.feedbackauthor, 1500);
            if (fb) out.push(fb.replace(/^/gm, "  > "));
          }
        }
      }
    }
  } catch (e) {
    out.push("", `(your submission unavailable: ${(e as Error).message})`);
  }

  try {
    const written = await getWorkshopReviewerAssessments(client, w.id);
    if (written.length) {
      out.push(
        "",
        `### Reviews you wrote (${written.length})`,
        table(
          ["assessment id", "submission", "grade you gave", "grading grade", "when"],
          written.map((a) => [a.id, a.submissionid, a.grade ?? "—", a.gradinggrade ?? "—", fmtDate(a.timecreated)]),
        ),
      );
    }
  } catch {
    /* optional */
  }

  try {
    const g = await getWorkshopGrades(client, w.id);
    const rows: (string | number)[][] = [];
    if (g.submissionlongstrgrade || g.submissionrawgrade != null) {
      rows.push(["submission grade", g.submissionlongstrgrade ?? String(g.submissionrawgrade)]);
    }
    if (g.assessmentlongstrgrade || g.assessmentrawgrade != null) {
      rows.push(["assessment grade", g.assessmentlongstrgrade ?? String(g.assessmentrawgrade)]);
    }
    // The call answers with `warnings` only while nothing is graded yet.
    if (rows.length) out.push("", "### Grades", table(["what", "value"], rows));
  } catch {
    /* optional */
  }
  return out;
}

async function genericDetail(
  client: MoodleClient,
  modname: string,
  cm: { course: number; id: number },
): Promise<string[]> {
  const plural = PLURALS[modname];
  if (!plural) return [];
  try {
    const instances = await getModInstances<WithCm>(client, modname, plural, cm.course);
    const inst = instances.find((x) => x.coursemodule === cm.id);
    if (!inst) return [];
    const out = genericFields(inst);
    const intro = html2md((inst.intro as string) ?? "", 4000);
    if (intro) out.push("", "### Description", intro);
    // page/book/label style modules carry the body in `content`.
    const content = html2md((inst.content as string) ?? "", 12_000);
    if (content) out.push("", "### Content", content);
    return out;
  } catch (e) {
    if (e instanceof MoodleError) return [`(no detail endpoint on this site: ${e.errorcode})`];
    throw e;
  }
}

export async function activityDetail(
  client: MoodleClient,
  cmid: number,
  opts: { attempt?: number } = {},
): Promise<string> {
  const cm = await getCourseModuleInfo(client, cmid);
  const sections = await courseSections(client, cm.course).catch(() => []);
  let entry: CourseModule | undefined;
  let sectionName = "";
  for (const s of sections) {
    const found = s.modules.find((m) => m.id === cmid);
    if (found) {
      entry = found;
      sectionName = `§${s.section} ${decodeEntities(s.name)}`;
      break;
    }
  }

  const head = [
    `# ${cm.name}`,
    `\`${cm.modname}\` · cmid ${cm.id} · instance ${cm.instance} · course ${cm.course}${sectionName ? ` · ${sectionName}` : ""}`,
  ];
  if (entry?.url) head.push(entry.url);
  if (entry && !entry.uservisible) head.push(`restricted: ${html2line(entry.availabilityinfo, 200) || "not available to you"}`);

  const body: string[] = [];
  switch (cm.modname) {
    case "assign":
      body.push(...(await assignDetail(client, cm)));
      break;
    case "quiz":
      body.push(...(await quizDetail(client, cm, opts.attempt)));
      break;
    case "forum":
      body.push(...(await forumDetail(client, cm)));
      break;
    case "choice":
      body.push(...(await choiceDetail(client, cm)));
      break;
    case "workshop":
      body.push(...(await workshopDetail(client, cm)));
      break;
    case "lti":
      body.push("**External runtime:** This activity launches a separate provider. Moodle's API cannot read or complete its exercise. Inspect the activity link in a browser; use a separate browser tool only if appropriate, or ask the student.");
      body.push(...(await genericDetail(client, cm.modname, cm)));
      break;
    case "scorm":
    case "h5pactivity":
      body.push(`**Package runtime:** ${cm.modname} exercises run inside a browser-based package. Moodle's API can expose metadata and results, but cannot perform its interactions. Inspect the activity link with a separate browser tool if appropriate, or ask the student.`);
      body.push(...(await genericDetail(client, cm.modname, cm)));
      break;
    default:
      if (!PLURALS[cm.modname]) {
        body.push("**Unknown activity type:** This server cannot determine its interaction requirements or complete it through a dedicated tool. Inspect its instructions and activity link; an external browser or student action may be needed.");
      }
      body.push(...(await genericDetail(client, cm.modname, cm)));
  }

  // The course-contents entry is the universal fallback: it always has the
  // description and the file list, whatever the module type.
  if (entry) {
    const desc = html2md(entry.description, 8000);
    if (desc && !body.some((b) => b.includes(desc.slice(0, 60)))) {
      body.push("", "### Activity description", desc);
    }
    body.push(...filesBlock(entry.contents, cmid));
    if (entry.dates?.length) {
      body.push(
        "",
        `Dates on the course page: ${entry.dates.map((d) => `${dateLabel(d)} ${fmtDate(d.timestamp)}`).join(" · ")}`,
      );
    }
  }

  if (body.length === 0) body.push("(no further detail available for this activity type)");
  return [head.join("\n"), "", ...body].join("\n");
}

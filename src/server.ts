import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { activityDetail } from "./tools/activity.js";
import { deadlines, grades } from "./tools/agenda.js";
import { courseOutline, coursesList, searchCourses } from "./tools/courses.js";
import { forum, messages } from "./tools/discuss.js";
import { notifications, whatsNew } from "./tools/feed.js";
import { download } from "./tools/files.js";
import { listFunctions, rawCall } from "./tools/raw.js";
import { clientFor, connect, disconnect, status } from "./tools/site.js";
import { MoodleError } from "./ws.js";

const SITE = {
  site: z
    .string()
    .optional()
    .describe("Which connected Moodle (host or URL). Optional while only one site is connected."),
};

const COURSE_REF = z
  .union([z.number(), z.string()])
  .describe("Course id, or part of its short/full name (must match exactly one course).");

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<string>): Promise<Result> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (e) {
    const err = e as Error;
    const hint =
      err instanceof MoodleError && err.needsReauth
        ? "\n\nThe stored token is no longer accepted. Run moodle_connect for this site again to mint a new one."
        : "";
    return { content: [{ type: "text", text: `Error: ${err.message}${hint}` }], isError: true };
  }
}

/**
 * A fresh McpServer per client session. The Server class binds 1:1 to a
 * transport, so HTTP mode needs one of these per connected client — while the
 * things that must stay single (the browser, the token store, the cache) live
 * in modules shared by all of them.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "moodle-mcp", version: "0.2.0" });

  /* ---------------- connection ---------------- */

  server.registerTool(
    "moodle_connect",
    {
      title: "Connect a Moodle site",
      description:
        "Connect to any Moodle site and store a web-service token. Probes the site first: username/password sites exchange credentials directly; SSO sites (Shibboleth/SAML/OAuth) open a visible browser window where you log in normally, then the token is minted through the Moodle mobile launch endpoint — no fiddling with dev tools. If it reports 'waiting', finish logging in and call it again with the same url.",
      inputSchema: {
        url: z.string().optional().describe("Moodle URL or host, e.g. moodle.tuni.fi. Omit to show current status."),
        username: z.string().optional().describe("Only for sites with a plain login form (typeoflogin=1)."),
        password: z.string().optional().describe("Never stored; exchanged for a token immediately."),
        wait_seconds: z
          .number()
          .optional()
          .describe("How long to wait for the browser login before returning 'waiting'. Default 45, max 120."),
      },
    },
    async (a) => run(() => connect({ url: a.url, username: a.username, password: a.password, waitSeconds: a.wait_seconds })),
  );

  server.registerTool(
    "moodle_status",
    {
      title: "Connected sites",
      description: "List connected Moodle sites and verify each stored token against the server.",
      inputSchema: {},
    },
    async () => run(() => status()),
  );

  server.registerTool(
    "moodle_disconnect",
    {
      title: "Forget a site",
      description: "Remove a site and its stored token from the local config.",
      inputSchema: { site: z.string().describe("Host or URL of the site to forget.") },
    },
    async (a) => run(() => disconnect(a.site)),
  );

  /* ---------------- reading ---------------- */

  server.registerTool(
    "moodle_courses",
    {
      title: "List courses",
      description: "List enrolled courses with ids, dates and completion progress. Start here to get course ids.",
      inputSchema: {
        filter: z
          .enum(["active", "all", "past", "future", "favourites"])
          .optional()
          .describe("Default 'active' (started, not yet ended)."),
        refresh: z.boolean().optional().describe("Bypass the 15-minute cache."),
        ...SITE,
      },
    },
    async (a) => run(async () => coursesList(await clientFor(a.site), a.filter ?? "active", a.refresh)),
  );

  server.registerTool(
    "moodle_outline",
    {
      title: "Course structure",
      description:
        "The whole course as compact markdown: sections, every activity with its cmid, dates, completion state, file names, and the teacher's description text stripped of HTML. This is the tool for questions like 'what is mandatory here', 'how is this course graded', 'what do I actually have to do' — the answer is usually buried in a label or section summary that this surfaces.",
      inputSchema: {
        course: COURSE_REF,
        sections: z.array(z.number()).optional().describe("Only these section numbers."),
        descriptions: z.boolean().optional().describe("Include description/summary text. Default true."),
        files: z.boolean().optional().describe("List attached file names. Default true."),
        max_desc_chars: z.number().optional().describe("Truncate each description. Default 2000."),
        refresh: z.boolean().optional(),
        ...SITE,
      },
    },
    async (a) =>
      run(async () =>
        courseOutline(await clientFor(a.site), a.course, {
          sections: a.sections,
          descriptions: a.descriptions,
          files: a.files,
          maxDescChars: a.max_desc_chars,
          refresh: a.refresh,
        }),
      ),
  );

  server.registerTool(
    "moodle_activity",
    {
      title: "One activity in full",
      description:
        "Everything about a single activity by cmid (from moodle_outline or moodle_deadlines): full description, dates, attached files, and type-specific detail — assignments add submission/grading state and allowed file types, quizzes add attempts and best grade, forums add their discussion list, choices add options and remaining capacity, workshops add the phase plan.",
      inputSchema: {
        cmid: z.number().describe("Course-module id."),
        attempt: z
          .number()
          .optional()
          .describe("Quizzes only: read this finished attempt's questions, your answers and the feedback."),
        ...SITE,
      },
    },
    async (a) => run(async () => activityDetail(await clientFor(a.site), a.cmid, { attempt: a.attempt })),
  );

  server.registerTool(
    "moodle_deadlines",
    {
      title: "What is due",
      description:
        "Actionable items across all courses, overdue first. Moodle drops an item from this list once it needs no action, so it doubles as a to-do list.",
      inputSchema: {
        days: z.number().optional().describe("Look ahead this many days. Default 30."),
        overdue_days: z.number().optional().describe("Look back this many days for overdue work. Default 21."),
        course: COURSE_REF.optional(),
        limit: z.number().optional(),
        ...SITE,
      },
    },
    async (a) =>
      run(async () =>
        deadlines(await clientFor(a.site), {
          days: a.days,
          overdueDays: a.overdue_days,
          course: a.course,
          limit: a.limit,
        }),
      ),
  );

  server.registerTool(
    "moodle_grades",
    {
      title: "Grades",
      description:
        "Course totals across all courses, or every grade item of one course with grade, range, percentage, weight and teacher feedback.",
      inputSchema: { course: COURSE_REF.optional(), ...SITE },
    },
    async (a) => run(async () => grades(await clientFor(a.site), a.course)),
  );

  server.registerTool(
    "moodle_search",
    {
      title: "Search course content",
      description:
        "Full-text search over cached course structures: section summaries, activity names, descriptions, file names and assignment briefs. Runs locally, so it works on sites where Moodle's global search is disabled. All terms must match.",
      inputSchema: {
        query: z.string().describe("Search terms, all of which must appear."),
        courses: z.array(z.union([z.number(), z.string()])).optional().describe("Limit to these courses. Default: recent ones."),
        limit: z.number().optional(),
        refresh: z.boolean().optional(),
        ...SITE,
      },
    },
    async (a) =>
      run(async () =>
        searchCourses(await clientFor(a.site), a.query, { courses: a.courses, limit: a.limit, refresh: a.refresh }),
      ),
  );

  server.registerTool(
    "moodle_forum",
    {
      title: "Forums and threads",
      description:
        "Forums of a course, discussions of a forum, or the full post tree of one discussion — depending on which argument you pass. Announcement forums are where course rule changes hide.",
      inputSchema: {
        course: COURSE_REF.optional().describe("List forums in this course."),
        forumid: z.number().optional().describe("List discussions in this forum."),
        cmid: z.number().optional().describe("Same, but identify the forum by course-module id."),
        discussion: z.number().optional().describe("Read this discussion's posts."),
        limit: z.number().optional(),
        ...SITE,
      },
    },
    async (a) =>
      run(async () =>
        forum(await clientFor(a.site), {
          course: a.course,
          forumid: a.forumid,
          cmid: a.cmid,
          discussion: a.discussion,
          limit: a.limit,
        }),
      ),
  );

  server.registerTool(
    "moodle_messages",
    {
      title: "Messages",
      description: "Moodle's private conversations: the list, or the messages of one conversation.",
      inputSchema: {
        conversation: z.number().optional().describe("Conversation id to read."),
        limit: z.number().optional(),
        ...SITE,
      },
    },
    async (a) => run(async () => messages(await clientFor(a.site), { conversation: a.conversation, limit: a.limit })),
  );

  server.registerTool(
    "moodle_notifications",
    {
      title: "Notification feed",
      description:
        "Moodle's own notification feed across every course — forum posts, deadline reminders, grading notices — newest first, with a deep link for each. The one place that answers 'what happened since I last looked' without crawling every course and forum.",
      inputSchema: {
        limit: z.number().optional().describe("How many to fetch. Default 20, max 100."),
        unread_only: z.boolean().optional(),
        full: z.boolean().optional().describe("Include the message bodies, not just subjects."),
        ...SITE,
      },
    },
    async (a) =>
      run(async () =>
        notifications(await clientFor(a.site), { limit: a.limit, unreadOnly: a.unread_only, full: a.full }),
      ),
  );

  server.registerTool(
    "moodle_whatsnew",
    {
      title: "What changed",
      description:
        "Activities changed in a course (or all current courses) within the last N days, from Moodle's own change log — new forum posts, edited materials, new files. Cheaper and more exact than re-reading course outlines.",
      inputSchema: {
        course: COURSE_REF.optional().describe("Default: all courses currently running."),
        days: z.number().optional().describe("Look back this many days. Default 7."),
        ...SITE,
      },
    },
    async (a) => run(async () => whatsNew(await clientFor(a.site), { course: a.course, days: a.days })),
  );

  /* ---------------- files ---------------- */

  server.registerTool(
    "moodle_download",
    {
      title: "Download files",
      description:
        "Download course files to disk and return their paths: one activity's files (cmid), an entire course's files (course), or a single URL. This server does not parse documents — read or OCR the downloaded paths with your own tools.",
      inputSchema: {
        cmid: z.number().optional().describe("All files of this activity, including assignment task attachments."),
        course: COURSE_REF.optional().describe("Every file in the course."),
        url: z.string().optional().describe("A single file URL on the connected Moodle site (signed with the token automatically; other hosts are refused)."),
        filter: z.string().optional().describe("Only files whose name or location contains this text."),
        dest: z.string().optional().describe("Folder inside the downloads root (~/.moodle-mcp/files, or MOODLE_MCP_DOWNLOADS); paths outside it are refused. Default <site>/<courseid>/ inside the root."),
        max: z.number().optional().describe("Safety cap on file count. Default 40."),
        ...SITE,
      },
    },
    async (a) =>
      run(async () =>
        download(await clientFor(a.site), {
          cmid: a.cmid,
          course: a.course,
          url: a.url,
          filter: a.filter,
          dest: a.dest,
          max: a.max,
        }),
      ),
  );

  /* ---------------- raw access ---------------- */

  server.registerTool(
    "moodle_call",
    {
      title: "Raw web-service call",
      description:
        "Call any Moodle web-service function directly and get raw JSON. The tools above cover the common ground; this covers the other ~430 functions and site-specific plugins. Read-only in v1: only names containing _get_, _search_, _is_, _can_ or _check_ are permitted.",
      inputSchema: {
        function: z.string().describe("e.g. core_completion_get_activities_completion_status"),
        params: z.record(z.unknown()).optional().describe("Arguments; arrays and objects are flattened Moodle-style."),
        max_chars: z.number().optional(),
        ...SITE,
      },
    },
    async (a) => run(async () => rawCall(await clientFor(a.site), a.function, a.params ?? {}, a.max_chars)),
  );

  server.registerTool(
    "moodle_functions",
    {
      title: "List web-service functions",
      description: "What this site's token can actually call — useful before reaching for moodle_call.",
      inputSchema: { filter: z.string().optional().describe("Substring filter, e.g. 'quiz'."), ...SITE },
    },
    async (a) => run(async () => listFunctions(await clientFor(a.site), a.filter)),
  );

  return server;
}

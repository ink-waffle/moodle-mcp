import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { activityDetail } from "./tools/activity.js";
import { deadlines, grades } from "./tools/agenda.js";
import { courseOutline, coursesList, searchCourses } from "./tools/courses.js";
import { forum, messages } from "./tools/discuss.js";
import { notifications, whatsNew } from "./tools/feed.js";
import { download } from "./tools/files.js";
import { addDatabaseEntry, addGlossaryEntry, addWikiPage, assessWorkshop, postForum, submitChoice, submitSurvey, submitWorkshop } from "./tools/interactions.js";
import { answerLesson, feedbackPage, finishLesson, launchFeedback, launchLesson, lessonPage, submitFeedbackPage } from "./tools/interactive-pages.js";
import { listFunctions, rawCall } from "./tools/raw.js";
import { clientFor, connect, disconnect, status } from "./tools/site.js";
import { finalizeAssignment, processQuiz, quizPage, saveQuiz, startAssignment, startQuiz, submitAssignment } from "./tools/submissions.js";
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
      description: "Everything about a single activity by cmid (from moodle_outline or moodle_deadlines): description, dates, files, and type-specific detail. Reports known browser-dependent runtimes and quiz question types when Moodle provides them; absence of a warning cannot prove that embedded or external content is API-complete. Inspect before starting an attempt.",
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

  /* ---------------- submissions ---------------- */

  server.registerTool(
    "moodle_upload_draft",
    {
      title: "Upload Moodle draft files",
      description: "Upload local files to your Moodle user draft area and return the item id for a supported activity's file field (e.g. a database entry). This does not submit the activity; pass the id to its dedicated submit tool. Uploads may count against your user quota.",
      inputSchema: {
        files: z.array(z.string()).min(1).describe("Absolute paths to distinct files to upload together."), ...SITE,
      },
    },
    async (a) => run(async () => `Draft item id: ${await (await clientFor(a.site)).upload(a.files)}.`),
  );

  const NAMED_VALUES = z.array(z.object({ name: z.string(), value: z.string() }));
  const PREFLIGHT = NAMED_VALUES.optional().describe("Quiz access-rule fields, e.g. [{name:'quizpassword',value:'...'}].");

  server.registerTool(
    "moodle_assignment_start",
    {
      title: "Start timed assignment",
      description: "Start the submission timer on a time-limited assignment. This creates or starts a real submission attempt; inspect moodle_activity first. Not needed for untimed assignments.",
      inputSchema: { cmid: z.number().int().positive(), ...SITE },
    },
    async (a) => run(async () => startAssignment(await clientFor(a.site), a.cmid)),
  );

  server.registerTool(
    "moodle_assignment_submit",
    {
      title: "Submit assignment files or text",
      description: "Upload local files into Moodle's draft area and save an assignment submission. Supply the complete file set and, if online text is enabled, its full text; this replaces existing submission content. On assignments with a draft stage, use moodle_assignment_finalize afterwards. On others, saving submits immediately. This changes your real submission; check moodle_activity first.",
      inputSchema: {
        cmid: z.number().int().positive().describe("Assignment course-module id from moodle_activity or moodle_outline."),
        files: z.array(z.string()).optional().describe("Complete file set (can be empty if online text is nonempty); replaces existing attached files when the file plugin is enabled."),
        text: z.string().optional().describe("Complete online-text answer, if that plugin is enabled."),
        ...SITE,
      },
    },
    async (a) => run(async () => submitAssignment(await clientFor(a.site), {
      cmid: a.cmid, files: a.files, text: a.text,
    })),
  );

  server.registerTool(
    "moodle_assignment_finalize",
    {
      title: "Finalize assignment draft",
      description: "Submit an existing assignment draft for grading. Only needed when submission drafts are enabled; this is a real, potentially irreversible submission. Review its statement and contents first.",
      inputSchema: {
        cmid: z.number().int().positive(),
        accept_statement: z.boolean().describe("Whether you accept the assignment's submission statement."),
        ...SITE,
      },
    },
    async (a) => run(async () => finalizeAssignment(await clientFor(a.site), {
      cmid: a.cmid, acceptStatement: a.accept_statement,
    })),
  );

  server.registerTool(
    "moodle_quiz_start",
    {
      title: "Start or resume quiz",
      description: "Start a real graded quiz attempt, or return an existing unfinished attempt without starting another. Starting may consume a limited attempt and start a timer. Inspect moodle_activity first for question types and browser limitations; the API cannot guarantee all quiz content is visible without Moodle's browser runtime.",
      inputSchema: { cmid: z.number().int().positive(), preflight: PREFLIGHT, ...SITE },
    },
    async (a) => run(async () => startQuiz(await clientFor(a.site), { cmid: a.cmid, preflight: a.preflight })),
  );

  server.registerTool(
    "moodle_quiz_page",
    {
      title: "Read quiz attempt page",
      description: "Read one in-progress quiz page as Moodle's question HTML and exact input names. This is not a complete visual or interactive view: media and scripted questions may require Moodle's browser runtime. Use another browser tool or ask the student when the page cannot be understood from the API; never invent answer fields.",
      inputSchema: { attemptid: z.number().int().positive(), page: z.number().int().nonnegative(), preflight: PREFLIGHT, ...SITE },
    },
    async (a) => run(async () => quizPage(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_quiz_save",
    {
      title: "Save quiz answers",
      description: "Autosave answers without finishing the quiz. Pass exact input name/value pairs from moodle_quiz_page, including each question's current sequencecheck. Moodle's question engine keeps one value per field name. A save does not submit the attempt.",
      inputSchema: { attemptid: z.number().int().positive(), data: NAMED_VALUES, preflight: PREFLIGHT, ...SITE },
    },
    async (a) => run(async () => saveQuiz(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_quiz_process",
    {
      title: "Process or finish quiz attempt",
      description: "Process question responses or finish an in-progress quiz attempt. Pass exact form name/value pairs (including sequencecheck) from moodle_quiz_page; use finish=true only when intentionally submitting the attempt for grading. This cannot be undone by a student.",
      inputSchema: {
        attemptid: z.number().int().positive(),
        data: NAMED_VALUES.optional(),
        finish: z.boolean(),
        preflight: PREFLIGHT,
        ...SITE,
      },
    },
    async (a) => run(async () => processQuiz(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_choice_submit",
    {
      title: "Submit course choice",
      description: "Submit one or more option ids from moodle_activity(cmid). This changes your answer (and may be locked against further changes).",
      inputSchema: { cmid: z.number().int().positive(), responses: z.array(z.number().int().positive()).min(1), ...SITE },
    },
    async (a) => run(async () => submitChoice(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_workshop_submit",
    {
      title: "Submit or update workshop work",
      description: "Create or update your workshop submission, with text and/or attachments. On update supply the complete content and complete file list: Moodle replaces existing content and attachments. Peer assessment is a separate tool.",
      inputSchema: {
        cmid: z.number().int().positive(), title: z.string(), content: z.string().optional().describe("Complete HTML content; required on update (use an empty string for files-only work)."),
        files: z.array(z.string()).optional().describe("Complete attachment file list; required on update (use [] to remove all files)."),
        submissionid: z.number().int().positive().optional().describe("Your existing submission id from moodle_activity; omit to create."),
        ...SITE,
      },
    },
    async (a) => run(async () => submitWorkshop(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_workshop_assess",
    {
      title: "Submit workshop peer assessment",
      description: "Save a peer review using the strategy-specific fields returned by moodle_call(mod_workshop_get_assessment_form_definition). This is a real assessment, potentially graded and visible to the author.",
      inputSchema: {
        assessmentid: z.number().int().positive().describe("Allocated assessment id from moodle_activity."),
        data: NAMED_VALUES.min(1).describe("Complete assessment-form field name/value pairs, including grades and feedback."),
        ...SITE,
      },
    },
    async (a) => run(async () => assessWorkshop(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_forum_post",
    {
      title: "Post forum discussion or reply",
      description: "Create a discussion in a course forum, or reply when parent_post_id is given. Optional local files are uploaded as attachments. Other participants may be notified; this is a real post.",
      inputSchema: {
        cmid: z.number().int().positive().describe("Forum course-module id."),
        subject: z.string(), message: z.string().describe("Post body as Moodle HTML."),
        parent_post_id: z.number().int().positive().optional().describe("Post id to reply to; omit to create a discussion."),
        groupid: z.number().int().nonnegative().optional().describe("Group for a new discussion; default 0."),
        files: z.array(z.string()).optional().describe("Absolute paths to post attachments."),
        ...SITE,
      },
    },
    async (a) => run(async () => postForum(await clientFor(a.site), {
      cmid: a.cmid, subject: a.subject, message: a.message, parentPostId: a.parent_post_id,
      groupid: a.groupid, files: a.files,
    })),
  );

  server.registerTool(
    "moodle_feedback_launch",
    {
      title: "Start or resume feedback",
      description: "Start or resume a feedback questionnaire. It returns the page number to read next; the final page submission completes the questionnaire.",
      inputSchema: {
        cmid: z.number().int().positive(),
        courseid: z.number().int().positive().optional().describe("Course context for a site-level feedback activity."),
        ...SITE,
      },
    },
    async (a) => run(async () => launchFeedback(await clientFor(a.site), a.cmid, a.courseid)),
  );

  server.registerTool(
    "moodle_feedback_page",
    {
      title: "Read feedback questions",
      description: "Read one feedback page (0-based), including each value-bearing item's inputname (typ_id). Checkbox responses use inputname[index] keys. Use these names in moodle_feedback_submit_page.",
      inputSchema: {
        cmid: z.number().int().positive(), page: z.number().int().nonnegative(),
        courseid: z.number().int().positive().optional().describe("Same course context passed to moodle_feedback_launch for site-level feedback."),
        ...SITE,
      },
    },
    async (a) => run(async () => feedbackPage(await clientFor(a.site), a.cmid, a.page, a.courseid)),
  );

  server.registerTool(
    "moodle_feedback_submit_page",
    {
      title: "Answer feedback page",
      description: "Save feedback answers and advance (or go back). Advancing from the last page submits the whole questionnaire, possibly irreversibly. Supply full response name/value pairs from the page's items.",
      inputSchema: {
        cmid: z.number().int().positive(), page: z.number().int().nonnegative(),
        responses: NAMED_VALUES, previous: z.boolean().optional(),
        courseid: z.number().int().positive().optional().describe("Same course context passed to moodle_feedback_launch for site-level feedback."),
        ...SITE,
      },
    },
    async (a) => run(async () => submitFeedbackPage(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_lesson_launch",
    {
      title: "Start or resume lesson",
      description: "Start a lesson attempt or continue from pageid. This may start a timer and consume a graded attempt; inspect moodle_activity first.",
      inputSchema: {
        cmid: z.number().int().positive(), password: z.string().optional(),
        pageid: z.number().int().nonnegative().optional().describe("Nonzero only to resume an existing page."), ...SITE,
      },
    },
    async (a) => run(async () => launchLesson(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_lesson_page",
    {
      title: "Read lesson page",
      description: "Read full lesson page contents, answer options and data needed to respond. Supply a pageid from the lesson navigation or moodle_call(mod_lesson_get_pages).",
      inputSchema: { cmid: z.number().int().positive(), pageid: z.number().int().positive(), password: z.string().optional(), ...SITE },
    },
    async (a) => run(async () => lessonPage(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_lesson_answer",
    {
      title: "Submit lesson page answer",
      description: "Send the exact name/value fields required by the lesson question type; may grade an answer and move to another page. Use moodle_lesson_page before answering.",
      inputSchema: {
        cmid: z.number().int().positive(), pageid: z.number().int().positive(), data: NAMED_VALUES,
        password: z.string().optional(), ...SITE,
      },
    },
    async (a) => run(async () => answerLesson(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_lesson_finish",
    {
      title: "Finish lesson attempt",
      description: "Finish the current lesson attempt and finalize its grade. Irreversible for a student; only call after reviewing all lesson pages.",
      inputSchema: { cmid: z.number().int().positive(), password: z.string().optional(), ...SITE },
    },
    async (a) => run(async () => finishLesson(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_glossary_add",
    {
      title: "Add glossary entry",
      description: "Create a course glossary entry, optionally with local file attachments. Visible to others immediately or after approval, depending on the glossary settings.",
      inputSchema: {
        cmid: z.number().int().positive(), concept: z.string(), definition: z.string().describe("Definition as Moodle HTML."),
        files: z.array(z.string()).optional().describe("Absolute paths to attachment files."), ...SITE,
      },
    },
    async (a) => run(async () => addGlossaryEntry(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_database_add",
    {
      title: "Add course database entry",
      description: "Create an entry in a Moodle database activity. Read its field ids and types first with moodle_call(mod_data_get_fields); values must match each field's type (strings, numbers, arrays, or draft item ids for file fields).",
      inputSchema: {
        cmid: z.number().int().positive(), groupid: z.number().int().nonnegative().optional(),
        fields: z.array(z.object({ fieldid: z.number().int().positive(), subfield: z.string().optional(), value: z.unknown() })).min(1),
        ...SITE,
      },
    },
    async (a) => run(async () => addDatabaseEntry(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_wiki_add_page",
    {
      title: "Create wiki page",
      description: "Create a new HTML page in the wiki's default subwiki, or a specific accessible subwiki. Read existing pages with moodle_call(mod_wiki_get_subwiki_pages) first; page titles must be unique.",
      inputSchema: {
        cmid: z.number().int().positive(), title: z.string(), content: z.string().describe("Complete page HTML."),
        subwikiid: z.number().int().positive().optional().describe("Existing subwiki id from moodle_call(mod_wiki_get_subwikis); omit to use the current user's default subwiki."),
        ...SITE,
      },
    },
    async (a) => run(async () => addWikiPage(await clientFor(a.site), a)),
  );

  server.registerTool(
    "moodle_survey_submit",
    {
      title: "Submit legacy survey",
      description: "Submit one complete response to a legacy Moodle Survey. This is normally one-time and irreversible. Read its questions with moodle_call(mod_survey_get_questions) and use form keys q<questionid> or qP<questionid> for preferred responses.",
      inputSchema: {
        cmid: z.number().int().positive(),
        answers: z.array(z.object({ key: z.string(), value: z.string() })).min(1),
        ...SITE,
      },
    },
    async (a) => run(async () => submitSurvey(await clientFor(a.site), a)),
  );

  /* ---------------- raw access ---------------- */

  server.registerTool(
    "moodle_call",
    {
      title: "Raw web-service call",
      description:
        "Call any Moodle web-service read function directly and get raw JSON. Writes use dedicated tools, not this raw endpoint; only names containing _get_, _search_, _is_, _can_ or _check_ are permitted.",
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

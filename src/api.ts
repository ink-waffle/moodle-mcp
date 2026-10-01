import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR } from "./config.js";
import { MoodleClient } from "./ws.js";

/* ---------- response shapes (only the fields this server uses) ---------- */

export interface Course {
  id: number;
  shortname: string;
  fullname: string;
  startdate: number;
  enddate: number;
  visible: number;
  hidden: boolean | number;
  isfavourite: boolean;
  progress: number | null;
  completed: boolean | null;
  enablecompletion: boolean;
  lastaccess: number | null;
  category: number;
  summary: string;
}

export interface ModuleContent {
  type: string;
  filename: string;
  filepath: string;
  filesize: number;
  fileurl: string;
  mimetype?: string;
  timemodified: number;
}

export interface CourseModule {
  id: number; // cmid
  instance: number;
  name: string;
  modname: string;
  modplural?: string;
  url?: string;
  visible: number;
  uservisible: boolean;
  availabilityinfo?: string;
  description?: string;
  completion: number;
  completiondata?: { state: number; timecompleted: number };
  dates?: { label: string; dataid?: string; timestamp: number }[];
  contents?: ModuleContent[];
  contentsinfo?: { filescount: number; filessize: number };
}

export interface CourseSection {
  id: number;
  name: string;
  section: number;
  summary: string;
  visible: number;
  uservisible: boolean;
  /** Moodle 4.5 subsections come back as their own section, delegated to a module. */
  component?: string | null;
  itemid?: number | null;
  modules: CourseModule[];
}

export interface Assignment {
  id: number;
  cmid: number;
  course: number;
  name: string;
  intro: string;
  duedate: number;
  allowsubmissionsfromdate: number;
  cutoffdate: number;
  grade: number;
  maxattempts: number;
  teamsubmission?: number;
  nosubmissions?: number;
  submissiondrafts?: number;
  requiresubmissionstatement?: number;
  submissionstatement?: string;
  introattachments?: ModuleContent[];
  introfiles?: ModuleContent[];
  configs?: { plugin: string; subtype: string; name: string; value: string }[];
}

export interface SubmissionStatus {
  lastattempt?: {
    submission?: { status: string; attemptnumber: number; timemodified: number; timestarted?: number | null; gradingstatus?: string };
    teamsubmission?: { status: string; timemodified: number; timestarted?: number | null };
    submissionsenabled: boolean;
    canedit: boolean;
    cansubmit: boolean;
    gradingstatus: string;
    extensionduedate?: number | null;
    timelimit?: number;
    graded?: boolean;
  };
  feedback?: {
    grade?: { grade: string; timemodified: number } | null;
    gradefordisplay?: string;
    gradeddate?: number;
  };
  assignmentdata?: { attachments?: { intro?: ModuleContent[] } };
  warnings?: { warningcode?: string; message?: string; item?: number }[];
}

export interface GradeItem {
  id: number;
  itemname: string | null;
  itemtype: string;
  itemmodule: string | null;
  cmid?: number | null;
  graderaw: number | null;
  gradeformatted: string;
  grademin: number;
  grademax: number;
  rangeformatted: string;
  percentageformatted: string;
  weightformatted: string | null;
  feedback: string;
}

export interface ActionEvent {
  id: number;
  name: string;
  description: string;
  activityname?: string;
  activitystr?: string;
  modulename?: string;
  eventtype: string;
  instance: number; // course-module id for activity events
  timesort: number;
  timestart: number;
  overdue: boolean;
  course?: { id: number; shortname: string; fullname: string };
  action?: { name: string; url: string; itemcount: number; actionable: boolean };
  url?: string;
}

export interface Forum {
  id: number;
  cmid: number;
  course: number;
  name: string;
  intro: string;
  type: string;
  numdiscussions: number;
  unreadpostscount?: number;
  duedate?: number;
  cutoffdate?: number;
}

export interface Discussion {
  id: number;
  discussion: number;
  subject: string;
  name: string;
  message: string;
  userfullname: string;
  created: number;
  modified: number;
  numreplies: number;
  numunread: number;
  pinned: boolean;
  attachment: string | number;
}

export interface ForumPost {
  id: number;
  discussionid: number;
  parentid: number | null;
  subject: string;
  message: string;
  timecreated: number;
  author?: { fullname: string };
  attachments?: { filename: string; fileurl: string; filesize: number }[];
  isdeleted: boolean;
}

export interface Conversation {
  id: number;
  name: string | null;
  type: number;
  membercount: number;
  unreadcount: number | null;
  isread: boolean;
  members: { id: number; fullname: string }[];
  messages: { id: number; text: string; timecreated: number; useridfrom: number }[];
}

export interface Notification {
  id: number;
  subject: string;
  fullmessage: string;
  fullmessagehtml: string;
  smallmessage: string;
  contexturl: string;
  contexturlname: string;
  component: string;
  eventtype: string;
  read: boolean;
  timecreated: number;
  timeread: number | null;
  customdata?: string;
}

export interface CourseUpdate {
  contextlevel: string;
  id: number; // cmid for contextlevel "module"
  updates: { name: string; timeupdated?: number; itemids?: number[] }[];
}

export interface CourseModuleInfo {
  id: number;
  course: number;
  name: string;
  modname: string;
  instance: number;
  section: number;
  sectionnum?: number;
  completion: number;
}

/* ---------- calls ---------- */

export async function getCourses(client: MoodleClient): Promise<Course[]> {
  return client.call<Course[]>("core_enrol_get_users_courses", {
    userid: client.site.userid,
    returnusercount: 0,
  });
}

export async function getCourseContents(client: MoodleClient, courseid: number): Promise<CourseSection[]> {
  return client.call<CourseSection[]>("core_course_get_contents", { courseid });
}

export async function getAssignments(client: MoodleClient, courseids: number[]): Promise<Assignment[]> {
  const res = await client.call<{ courses: { id: number; assignments: Assignment[] }[] }>(
    "mod_assign_get_assignments",
    { courseids },
  );
  return res.courses.flatMap((c) => c.assignments.map((a) => ({ ...a, course: c.id })));
}

export async function getSubmissionStatus(client: MoodleClient, assignid: number): Promise<SubmissionStatus> {
  return client.call<SubmissionStatus>("mod_assign_get_submission_status", { assignid });
}

export async function getCourseGradesOverview(
  client: MoodleClient,
): Promise<{ courseid: number; grade: string; rawgrade: number | null }[]> {
  const res = await client.call<{ grades: { courseid: number; grade: string; rawgrade: number | null }[] }>(
    "gradereport_overview_get_course_grades",
  );
  return res.grades ?? [];
}

export async function getGradeItems(client: MoodleClient, courseid: number): Promise<GradeItem[]> {
  // userid must be explicit: omitting it means "all users" and fails with nopermissions.
  const res = await client.call<{ usergrades: { gradeitems: GradeItem[] }[] }>(
    "gradereport_user_get_grade_items",
    { courseid, userid: client.site.userid },
  );
  return res.usergrades?.[0]?.gradeitems ?? [];
}

export async function getActionEvents(
  client: MoodleClient,
  fromUnix: number,
  toUnix: number,
  limit = 50,
): Promise<ActionEvent[]> {
  const res = await client.call<{ events: ActionEvent[] }>("core_calendar_get_action_events_by_timesort", {
    timesortfrom: fromUnix,
    timesortto: toUnix,
    limitnum: limit,
    limittononsuspendedevents: true,
  });
  return res.events ?? [];
}

export async function getForums(client: MoodleClient, courseids: number[]): Promise<Forum[]> {
  return client.call<Forum[]>("mod_forum_get_forums_by_courses", { courseids });
}

export async function getDiscussions(
  client: MoodleClient,
  forumid: number,
  perpage = 10,
): Promise<Discussion[]> {
  // Note: sortby/sortdirection belong to the deprecated *_paginated variant and are
  // rejected here; this function takes an integer sortorder, whose default is fine.
  const res = await client.call<{ discussions: Discussion[] }>("mod_forum_get_forum_discussions", {
    forumid,
    page: 0,
    perpage,
  });
  return res.discussions ?? [];
}

export async function getDiscussionPosts(client: MoodleClient, discussionid: number): Promise<ForumPost[]> {
  const res = await client.call<{ posts: ForumPost[] }>("mod_forum_get_discussion_posts", { discussionid });
  return res.posts ?? [];
}

export async function getConversations(client: MoodleClient, limit = 15): Promise<Conversation[]> {
  const res = await client.call<{ conversations: Conversation[] }>("core_message_get_conversations", {
    userid: client.site.userid,
    limitfrom: 0,
    limitnum: limit,
  });
  return res.conversations ?? [];
}

export async function getConversationMessages(
  client: MoodleClient,
  conversationid: number,
  limit = 30,
): Promise<{ messages: { id: number; text: string; timecreated: number; useridfrom: number }[]; members: { id: number; fullname: string }[] }> {
  return client.call("core_message_get_conversation_messages", {
    currentuserid: client.site.userid,
    convid: conversationid,
    limitfrom: 0,
    limitnum: limit,
    newest: true,
  });
}

export async function getCourseModuleInfo(client: MoodleClient, cmid: number): Promise<CourseModuleInfo> {
  const res = await client.call<{ cm: CourseModuleInfo }>("core_course_get_course_module", { cmid });
  return res.cm;
}

/** Generic "<mod>_get_<things>_by_courses" reader, used for the long tail of activity types. */
export async function getModInstances<T = Record<string, unknown>>(
  client: MoodleClient,
  modname: string,
  plural: string,
  courseid: number,
): Promise<T[]> {
  const res = await client.call<Record<string, T[]>>(`mod_${modname}_get_${plural}_by_courses`, {
    courseids: [courseid],
  });
  return res[plural] ?? [];
}

export async function getNotifications(
  client: MoodleClient,
  limit = 20,
): Promise<{ notifications: Notification[]; unreadcount: number }> {
  return client.call("message_popup_get_popup_notifications", {
    useridto: client.site.userid,
    newestfirst: 1,
    limit,
    offset: 0,
  });
}

export async function getUpdatesSince(
  client: MoodleClient,
  courseid: number,
  sinceUnix: number,
): Promise<CourseUpdate[]> {
  const res = await client.call<{ instances: CourseUpdate[] }>("core_course_get_updates_since", {
    courseid,
    since: sinceUnix,
  });
  return res.instances ?? [];
}

/* ---------- workshop: the peer-review triple ---------- */

export interface WorkshopSubmission {
  id: number;
  title: string;
  content: string;
  timecreated: number;
  timemodified: number;
  grade?: number | null;
  gradeover?: number | null;
  published?: boolean;
  attachmentfiles?: ModuleContent[];
  contentfiles?: ModuleContent[];
}

export interface WorkshopAssessment {
  id: number;
  submissionid: number;
  reviewerid: number;
  weight: number;
  timecreated: number;
  grade: number | null;
  gradinggrade: number | null;
  feedbackauthor: string;
  feedbackreviewer?: string;
  form?: unknown;
}

export async function getWorkshopSubmissions(
  client: MoodleClient,
  workshopid: number,
): Promise<WorkshopSubmission[]> {
  const res = await client.call<{ submissions: WorkshopSubmission[] }>("mod_workshop_get_submissions", {
    workshopid,
    userid: client.site.userid,
  });
  return res.submissions ?? [];
}

export async function getWorkshopSubmissionAssessments(
  client: MoodleClient,
  submissionid: number,
): Promise<WorkshopAssessment[]> {
  const res = await client.call<{ assessments: WorkshopAssessment[] }>(
    "mod_workshop_get_submission_assessments",
    { submissionid },
  );
  return res.assessments ?? [];
}

export async function getWorkshopReviewerAssessments(
  client: MoodleClient,
  workshopid: number,
): Promise<WorkshopAssessment[]> {
  const res = await client.call<{ assessments: WorkshopAssessment[] }>(
    "mod_workshop_get_reviewer_assessments",
    { workshopid },
  );
  return res.assessments ?? [];
}

/** Returns only `warnings` when nothing is graded yet — every field is optional. */
export async function getWorkshopGrades(
  client: MoodleClient,
  workshopid: number,
): Promise<{
  submissionrawgrade?: number | null;
  submissionlongstrgrade?: string;
  assessmentrawgrade?: number | null;
  assessmentlongstrgrade?: string;
  submissiongradehidden?: boolean;
  assessmentgradehidden?: boolean;
}> {
  return client.call("mod_workshop_get_grades", { workshopid, userid: client.site.userid });
}

/* ---------- cache (course contents are the expensive, reusable payload) ---------- */

const DEFAULT_TTL_MS = 15 * 60 * 1000;

function cachePath(client: MoodleClient, name: string): string {
  return join(CACHE_DIR, client.site.key, `${name}.json`);
}

export async function cached<T>(
  client: MoodleClient,
  name: string,
  producer: () => Promise<T>,
  opts: {
    refresh?: boolean;
    ttlMs?: number;
    /**
     * Called when the entry is past its TTL. Returning true means "still fresh,
     * just stamp it" — one cheap call beats refetching a megabyte of course
     * contents. Throwing or returning false falls through to the producer.
     */
    validate?: (cachedAtUnix: number) => Promise<boolean>;
  } = {},
): Promise<T> {
  const path = cachePath(client, name);
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (!opts.refresh) {
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as { at: number; data: T };
      if (Date.now() - raw.at < ttl) return raw.data;
      if (opts.validate) {
        const stillFresh = await opts.validate(Math.floor(raw.at / 1000)).catch(() => false);
        if (stillFresh) {
          await writeFile(path, JSON.stringify({ at: Date.now(), data: raw.data })).catch(() => {});
          return raw.data;
        }
      }
    } catch {
      /* cache miss */
    }
  }
  const data = await producer();
  await mkdir(join(CACHE_DIR, client.site.key), { recursive: true });
  await writeFile(path, JSON.stringify({ at: Date.now(), data })).catch(() => {});
  return data;
}

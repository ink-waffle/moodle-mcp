import { getCourseModuleInfo } from "../api.js";
import type { MoodleClient } from "../ws.js";
import { checked } from "./submissions.js";

type Warning = { warningcode?: string; message?: string };
type NamedValue = { name: string; value: string };

async function activityId(client: MoodleClient, cmid: number, kind: string): Promise<number> {
  const cm = await getCourseModuleInfo(client, cmid);
  if (cm.modname !== kind) throw new Error(`cmid ${cmid} is ${cm.modname}, not ${kind}.`);
  return cm.instance;
}

export async function launchFeedback(client: MoodleClient, cmid: number, courseid?: number): Promise<string> {
  const feedbackid = await activityId(client, cmid, "feedback");
  const result = checked(await client.call<{ gopage: number; warnings?: Warning[] }>(
    "mod_feedback_launch_feedback", { feedbackid, courseid }), "Starting feedback");
  return result.gopage === -1
    ? `Feedback cmid ${cmid}: your response is on the last page. Read pages from 0 with moodle_feedback_page until hasnextpage is false; -1 is a launch sentinel, not a valid page index.`
    : `Feedback cmid ${cmid}: resume on page ${result.gopage}. Read its items with moodle_feedback_page.`;
}

export async function feedbackPage(client: MoodleClient, cmid: number, page: number, courseid?: number): Promise<string> {
  const feedbackid = await activityId(client, cmid, "feedback");
  const result = checked(await client.call<{ items: { id: number; typ: string; hasvalue: boolean }[]; hasprevpage: boolean; hasnextpage: boolean; warnings?: Warning[] }>(
    "mod_feedback_get_page_items", { feedbackid, page, courseid }), "Reading feedback page");
  return JSON.stringify({
    ...result,
    items: result.items.map((item) => ({ ...item, ...(item.hasvalue ? { inputname: `${item.typ}_${item.id}` } : {}) })),
  }, null, 2);
}

export async function submitFeedbackPage(client: MoodleClient, args: {
  cmid: number;
  page: number;
  responses: NamedValue[];
  previous?: boolean;
  courseid?: number;
}): Promise<string> {
  const { cmid, page, responses, previous = false, courseid } = args;
  const feedbackid = await activityId(client, cmid, "feedback");
  const result = checked(await client.call<{ completed: boolean; jumpto: number; completionpagecontents?: string; warnings?: Warning[] }>(
    "mod_feedback_process_page", { feedbackid, page, responses, goprevious: previous, courseid }), "Submitting feedback page");
  return JSON.stringify(result, null, 2);
}

export async function launchLesson(client: MoodleClient, args: { cmid: number; password?: string; pageid?: number }): Promise<string> {
  const { cmid, password = "", pageid = 0 } = args;
  const lessonid = await activityId(client, cmid, "lesson");
  const result = checked(await client.call<{ messages: unknown[]; warnings?: Warning[] }>(
    "mod_lesson_launch_attempt", { lessonid, password, pageid }), "Starting lesson");
  return JSON.stringify(result, null, 2);
}

export async function lessonPage(client: MoodleClient, args: { cmid: number; pageid: number; password?: string }): Promise<string> {
  const { cmid, pageid, password = "" } = args;
  const lessonid = await activityId(client, cmid, "lesson");
  const result = checked(await client.call<{ warnings?: Warning[]; [key: string]: unknown }>(
    "mod_lesson_get_page_data", { lessonid, pageid, password, returncontents: true }), "Reading lesson page");
  return JSON.stringify(result, null, 2);
}

export async function answerLesson(client: MoodleClient, args: {
  cmid: number;
  pageid: number;
  data: NamedValue[];
  password?: string;
}): Promise<string> {
  const { cmid, pageid, data, password = "" } = args;
  const lessonid = await activityId(client, cmid, "lesson");
  const result = checked(await client.call<{ warnings?: Warning[]; [key: string]: unknown }>(
    "mod_lesson_process_page", { lessonid, pageid, data, password }), "Answering lesson page");
  return JSON.stringify(result, null, 2);
}

export async function finishLesson(client: MoodleClient, args: { cmid: number; password?: string }): Promise<string> {
  const { cmid, password = "" } = args;
  const lessonid = await activityId(client, cmid, "lesson");
  const result = checked(await client.call<{ warnings?: Warning[]; [key: string]: unknown }>(
    "mod_lesson_finish_attempt", { lessonid, password }), "Finishing lesson attempt");
  return JSON.stringify(result, null, 2);
}

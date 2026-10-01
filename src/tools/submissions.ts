import { basename } from "node:path";
import { getAssignments, getCourseModuleInfo, getSubmissionStatus, type Assignment } from "../api.js";
import type { MoodleClient } from "../ws.js";

type Warning = { warningcode?: string; message?: string; item?: number };
type NamedValue = { name: string; value: string };

export function checked<T extends { warnings?: Warning[] } | Warning[]>(result: T, action: string): T {
  const warnings = Array.isArray(result) ? result : result.warnings;
  if (warnings?.length) {
    throw new Error(`${action}: ${warnings.map((w) => `${w.warningcode ?? "warning"}: ${w.message ?? "unknown error"}`).join("; ")}`);
  }
  return result;
}

async function assignmentFor(client: MoodleClient, cmid: number): Promise<Assignment> {
  const cm = await getCourseModuleInfo(client, cmid);
  if (cm.modname !== "assign") throw new Error(`cmid ${cmid} is ${cm.modname}, not an assignment.`);
  const assignments = await getAssignments(client, [cm.course]);
  const assignment = assignments.find((a) => a.id === cm.instance);
  if (!assignment) throw new Error(`Assignment cmid ${cmid} is not available to this user.`);
  return assignment;
}

function pluginEnabled(assignment: Assignment, plugin: string): boolean {
  return assignment.configs?.some((c) => c.subtype === "assignsubmission" && c.plugin === plugin && c.name === "enabled" && c.value === "1") ?? false;
}

export async function startAssignment(client: MoodleClient, cmid: number): Promise<string> {
  const assignment = await assignmentFor(client, cmid);
  const before = checked(await getSubmissionStatus(client, assignment.id), "Checking assignment status");
  if (!before.lastattempt?.timelimit) throw new Error("This assignment has no submission timer; start is unnecessary.");
  if (!before.lastattempt.submissionsenabled || !before.lastattempt.canedit) {
    throw new Error("Moodle reports that this submission cannot be started.");
  }
  const result = checked(await client.call<{ submissionid: number; warnings?: Warning[] }>(
    "mod_assign_start_submission", { assignid: assignment.id }), "Starting timed assignment");
  return `Assignment ${assignment.name} (cmid ${cmid}): timed submission ${result.submissionid} started.`;
}

export async function submitAssignment(client: MoodleClient, args: {
  cmid: number;
  files?: string[];
  text?: string;
}): Promise<string> {
  const { cmid, files, text } = args;
  const assignment = await assignmentFor(client, cmid);
  if (assignment.nosubmissions) throw new Error("This assignment does not accept submissions.");
  const hasFiles = pluginEnabled(assignment, "file");
  const hasText = pluginEnabled(assignment, "onlinetext");
  if (!hasFiles && !hasText) throw new Error("This assignment has no supported file or online-text submission plugin.");
  if (hasFiles && files === undefined) throw new Error("Provide the complete file set, even if empty, to avoid losing existing files.");
  if (!hasFiles && files?.length) throw new Error("This assignment does not accept file submissions.");
  if (hasText && text === undefined) throw new Error("Provide the complete online text, even if empty, to avoid losing existing text.");
  if (!hasText && text !== undefined) throw new Error("This assignment does not accept online text.");
  if (!files?.length && !text?.trim()) throw new Error("A submission needs at least one file or nonempty online text.");
  if (files) {
    const names = files.map((path) => basename(path));
    if (new Set(names).size !== names.length) throw new Error("Files must have distinct basenames for Moodle's draft area.");
    const max = assignment.configs?.find((c) => c.plugin === "file" && c.name === "maxfilesubmissions")?.value;
    if (max && files.length > Number(max)) throw new Error(`This assignment allows at most ${max} files.`);
  }
  const before = checked(await getSubmissionStatus(client, assignment.id), "Checking assignment status");
  if (!before.lastattempt?.submissionsenabled || !before.lastattempt.canedit) {
    throw new Error("Moodle reports that this submission is not editable; nothing was uploaded.");
  }
  if (before.lastattempt.timelimit && !((before.lastattempt.teamsubmission ?? before.lastattempt.submission)?.timestarted)) {
    throw new Error("Start this timed assignment with moodle_assignment_start before uploading work.");
  }
  if (assignment.requiresubmissionstatement && !assignment.submissiondrafts) {
    throw new Error("This no-draft assignment requires a submission statement, but Moodle's save_submission API cannot record acceptance. Use moodle_activity(cmid) for the Moodle link; submit there with the student's review, or use a separate browser tool if appropriate.");
  }

  const plugindata: Record<string, unknown> = {};
  if (hasFiles) plugindata.files_filemanager = files!.length ? await client.upload(files!) : 0;
  if (hasText) plugindata.onlinetext_editor = { text, format: 1, itemid: 0 };
  checked(await client.call<Warning[]>("mod_assign_save_submission", { assignmentid: assignment.id, plugindata }), "Saving assignment");
  const after = checked(await getSubmissionStatus(client, assignment.id), "Checking saved assignment");
  const status = (assignment.teamsubmission ? after.lastattempt?.teamsubmission?.status : after.lastattempt?.submission?.status);
  if (status !== "draft" && status !== "submitted") throw new Error(`Save returned without warnings, but assignment status is ${status ?? "missing"}. Check Moodle before retrying.`);
  return `Assignment ${assignment.name} (cmid ${cmid}): ${status}; ${files?.length ?? 0} file(s)${hasText ? " and online text" : ""} saved.${status === "draft" ? " Call moodle_assignment_finalize to submit this draft for grading." : ""}`;
}

export async function finalizeAssignment(client: MoodleClient, args: { cmid: number; acceptStatement: boolean }): Promise<string> {
  const { cmid, acceptStatement } = args;
  const assignment = await assignmentFor(client, cmid);
  const before = checked(await getSubmissionStatus(client, assignment.id), "Checking assignment status");
  const draftStatus = assignment.teamsubmission ? before.lastattempt?.teamsubmission?.status : before.lastattempt?.submission?.status;
  if (draftStatus !== "draft") {
    throw new Error("No draft submission exists to finalize. Use moodle_assignment_submit first.");
  }
  const lastAttempt = before.lastattempt;
  if (!lastAttempt?.cansubmit) throw new Error("Moodle reports that this draft cannot be submitted for grading.");
  if (assignment.requiresubmissionstatement && !acceptStatement) {
    throw new Error(`Accept the assignment submission statement first: ${assignment.submissionstatement ?? "See the assignment page."}`);
  }
  checked(await client.call<Warning[]>("mod_assign_submit_for_grading", {
    assignmentid: assignment.id,
    acceptsubmissionstatement: acceptStatement,
  }), "Finalizing assignment");
  const after = checked(await getSubmissionStatus(client, assignment.id), "Checking finalized assignment");
  const status = assignment.teamsubmission ? after.lastattempt?.teamsubmission?.status : after.lastattempt?.submission?.status;
  if (status !== "submitted") throw new Error(`Finalization returned without warnings, but assignment status is ${status ?? "missing"}. Check Moodle before retrying.`);
  return `Assignment ${assignment.name} (cmid ${cmid}): submitted for grading.`;
}

export async function startQuiz(client: MoodleClient, args: { cmid: number; preflight?: NamedValue[] }): Promise<string> {
  const { cmid, preflight = [] } = args;
  const cm = await getCourseModuleInfo(client, cmid);
  if (cm.modname !== "quiz") throw new Error(`cmid ${cmid} is ${cm.modname}, not a quiz.`);
  const attempts = checked(await client.call<{ attempts: { id: number; attempt: number; state: string; currentpage: number }[]; warnings?: Warning[] }>(
    "mod_quiz_get_user_attempts", { quizid: cm.instance, status: "unfinished" }), "Checking existing quiz attempts");
  const current = attempts.attempts.find((attempt) => attempt.state === "inprogress" || attempt.state === "overdue");
  if (current) {
    return `Quiz ${cm.name}: existing attempt #${current.attempt}, id ${current.id}, state ${current.state}, current page ${current.currentpage}. Use moodle_quiz_page to resume; no new attempt was started.`;
  }
  const access = checked(await client.call<{ canattempt: boolean; preventaccessreasons?: string[]; warnings?: Warning[] }>(
    "mod_quiz_get_quiz_access_information", { quizid: cm.instance }), "Checking quiz access");
  if (!access.canattempt || access.preventaccessreasons?.length) {
    throw new Error(`Quiz cannot be attempted: ${access.preventaccessreasons?.join("; ") || "Moodle denied access"}`);
  }
  const attemptAccess = checked(await client.call<{ preventnewattemptreasons: string[]; warnings?: Warning[] }>(
    "mod_quiz_get_attempt_access_information", { quizid: cm.instance }), "Checking new attempt access");
  if (attemptAccess.preventnewattemptreasons.length) {
    throw new Error(`Quiz cannot start a new attempt: ${attemptAccess.preventnewattemptreasons.join("; ")}`);
  }
  const started = checked(await client.call<{ attempt: { id: number; attempt: number; state: string }; warnings?: Warning[] }>(
    "mod_quiz_start_attempt", { quizid: cm.instance, preflightdata: preflight, forcenew: false }), "Starting quiz");
  return `Quiz ${cm.name}: attempt #${started.attempt.attempt}, id ${started.attempt.id}, state ${started.attempt.state}. Use moodle_quiz_page with this attempt id to read question HTML and input names.`;
}

export async function quizPage(client: MoodleClient, args: { attemptid: number; page: number; preflight?: NamedValue[] }): Promise<string> {
  const { attemptid, page, preflight = [] } = args;
  const result = checked(await client.call<{ questions: unknown[]; warnings?: Warning[]; [key: string]: unknown }>(
    "mod_quiz_get_attempt_data", { attemptid, page, preflightdata: preflight }), "Reading quiz page");
  return JSON.stringify({
    ...result,
    mcpLimitations: "Question HTML is not a complete visual or interactive view. Images, media, scripted controls and external content may need Moodle's browser runtime. If the question cannot be understood from this response, use a separate browser tool or ask the student; never infer missing content or answer fields.",
  }, null, 2);
}

function assertUniqueNames(data: NamedValue[]): void {
  if (new Set(data.map((field) => field.name)).size !== data.length) {
    throw new Error("Duplicate answer field names would overwrite each other in Moodle's question engine.");
  }
}

export async function saveQuiz(client: MoodleClient, args: { attemptid: number; data: NamedValue[]; preflight?: NamedValue[] }): Promise<string> {
  const { attemptid, data, preflight = [] } = args;
  assertUniqueNames(data);
  const result = checked(await client.call<{ status: boolean; warnings?: Warning[] }>(
    "mod_quiz_save_attempt", { attemptid, data, preflightdata: preflight }), "Saving quiz answers");
  if (!result.status) throw new Error("Moodle did not confirm saving the answers.");
  return `Quiz attempt ${attemptid}: answers saved (not finished).`;
}

export async function processQuiz(client: MoodleClient, args: {
  attemptid: number;
  data?: NamedValue[];
  preflight?: NamedValue[];
  finish: boolean;
}): Promise<string> {
  const { attemptid, data = [], preflight = [], finish } = args;
  assertUniqueNames(data);
  const result = checked(await client.call<{ state: string; warnings?: Warning[] }>(
    "mod_quiz_process_attempt", { attemptid, data, preflightdata: preflight, finishattempt: finish }),
  finish ? "Finishing quiz" : "Processing quiz answers");
  return `Quiz attempt ${attemptid}: ${result.state}${finish && result.state !== "finished" ? " (not confirmed finished; check Moodle)" : ""}.`;
}

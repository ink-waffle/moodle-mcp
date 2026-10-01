import { basename } from "node:path";
import { getCourseModuleInfo } from "../api.js";
import type { MoodleClient } from "../ws.js";
import { checked } from "./submissions.js";

type Warning = { warningcode?: string; message?: string };
type NamedValue = { name: string; value: string };

async function instanceFor(client: MoodleClient, cmid: number, expected: string): Promise<number> {
  const cm = await getCourseModuleInfo(client, cmid);
  if (cm.modname !== expected) throw new Error(`cmid ${cmid} is ${cm.modname}, not ${expected}.`);
  return cm.instance;
}

async function attachments(client: MoodleClient, files?: string[]): Promise<number> {
  if (!files?.length) return 0;
  const names = files.map((path) => basename(path));
  if (new Set(names).size !== names.length) throw new Error("Files must have distinct basenames.");
  return client.upload(files);
}

export async function submitChoice(client: MoodleClient, args: { cmid: number; responses: number[] }): Promise<string> {
  const { cmid, responses } = args;
  if (!responses.length || new Set(responses).size !== responses.length) throw new Error("Provide distinct choice option ids.");
  const choiceid = await instanceFor(client, cmid, "choice");
  const options = checked(await client.call<{ options: { id: number; disabled: boolean }[]; warnings?: Warning[] }>(
    "mod_choice_get_choice_options", { choiceid }), "Reading choice options");
  for (const response of responses) {
    const option = options.options.find((o) => o.id === response);
    if (!option || option.disabled) throw new Error(`Choice option ${response} is not available.`);
  }
  const result = checked(await client.call<{ answers: { optionid: number }[]; warnings?: Warning[] }>(
    "mod_choice_submit_choice_response", { choiceid, responses }), "Submitting choice");
  return `Choice cmid ${cmid}: saved option id(s) ${result.answers.map((a) => a.optionid).join(", ")}.`;
}

export async function submitWorkshop(client: MoodleClient, args: {
  cmid: number;
  title: string;
  content?: string;
  files?: string[];
  submissionid?: number;
}): Promise<string> {
  const { cmid, title, content, files, submissionid } = args;
  if (!title.trim() || (!content?.trim() && !files?.length)) throw new Error("Provide a title and either content or files.");
  if (submissionid && (content === undefined || files === undefined)) {
    throw new Error("Updating a workshop submission replaces its content and attachments; provide complete content and files, including an empty string or list when appropriate.");
  }
  const workshopid = await instanceFor(client, cmid, "workshop");
  const access = checked(await client.call<{
    creatingsubmissionallowed: boolean;
    modifyingsubmissionallowed: boolean;
    warnings?: Warning[];
  }>("mod_workshop_get_workshop_access_information", { workshopid }), "Checking workshop access");
  if (submissionid ? !access.modifyingsubmissionallowed : !access.creatingsubmissionallowed) {
    throw new Error(`Workshop submissions cannot be ${submissionid ? "updated" : "created"} now; nothing was uploaded.`);
  }
  if (submissionid) {
    const existing = checked(await client.call<{ submission: { workshopid: number; authorid: number }; warnings?: Warning[] }>(
      "mod_workshop_get_submission", { submissionid }), "Checking workshop submission");
    if (existing.submission.workshopid !== workshopid || existing.submission.authorid !== client.site.userid) {
      throw new Error("That submission is not yours in this workshop.");
    }
  }
  const attachmentsid = await attachments(client, files);
  const fn = submissionid ? "mod_workshop_update_submission" : "mod_workshop_add_submission";
  const result = checked(await client.call<{ status: boolean; submissionid?: number; warnings?: Warning[] }>(fn, {
    ...(submissionid ? { submissionid } : { workshopid }), title, content: content ?? "", contentformat: 1, attachmentsid,
  }), "Saving workshop submission");
  if (!result.status) throw new Error("Moodle did not confirm saving the workshop submission.");
  return `Workshop cmid ${cmid}: ${submissionid ? "updated" : "created"} submission ${result.submissionid ?? submissionid}; ${files?.length ?? 0} attachment(s).`;
}

export async function assessWorkshop(client: MoodleClient, args: { assessmentid: number; data: NamedValue[] }): Promise<string> {
  const { assessmentid, data } = args;
  if (!data.length) throw new Error("Provide assessment form fields from mod_workshop_get_assessment_form_definition.");
  const result = checked(await client.call<{ status: boolean; rawgrade?: number; warnings?: Warning[] }>(
    "mod_workshop_update_assessment", { assessmentid, data }), "Saving workshop peer assessment");
  if (!result.status) throw new Error("Moodle did not confirm the workshop assessment.");
  return `Workshop assessment ${assessmentid} saved${result.rawgrade === undefined ? "" : `; raw grade ${result.rawgrade}`}.`;
}

export async function addGlossaryEntry(client: MoodleClient, args: {
  cmid: number;
  concept: string;
  definition: string;
  files?: string[];
}): Promise<string> {
  const { cmid, concept, definition, files } = args;
  if (!concept.trim() || !definition.trim()) throw new Error("Glossary concept and definition must be nonempty.");
  const glossaryid = await instanceFor(client, cmid, "glossary");
  const attachmentsid = await attachments(client, files);
  const result = checked(await client.call<{ entryid: number; warnings?: Warning[] }>("mod_glossary_add_entry", {
    glossaryid, concept, definition, definitionformat: 1,
    options: attachmentsid ? [{ name: "attachmentsid", value: String(attachmentsid) }] : [],
  }), "Adding glossary entry");
  return `Glossary cmid ${cmid}: entry ${result.entryid} created.`;
}

export async function addDatabaseEntry(client: MoodleClient, args: {
  cmid: number;
  groupid?: number;
  fields: { fieldid: number; subfield?: string; value?: unknown }[];
}): Promise<string> {
  const { cmid, groupid = 0, fields } = args;
  if (!fields.length || fields.some((field) => field.value === undefined)) {
    throw new Error("Provide a value for every database field from mod_data_get_fields.");
  }
  const databaseid = await instanceFor(client, cmid, "data");
  const result = checked(await client.call<{
    newentryid: number;
    generalnotifications: string[];
    fieldnotifications: { fieldname: string; notification: string }[];
    warnings?: Warning[];
  }>("mod_data_add_entry", {
    databaseid, groupid, data: fields.map((field) => ({
      fieldid: field.fieldid, subfield: field.subfield ?? "", value: JSON.stringify(field.value),
    })),
  }), "Adding database entry");
  if (!result.newentryid) {
    throw new Error(`Moodle did not create the entry: ${[
      ...result.generalnotifications,
      ...result.fieldnotifications.map((n) => `${n.fieldname}: ${n.notification}`),
    ].join("; ") || "validation failed"}`);
  }
  return `Database cmid ${cmid}: entry ${result.newentryid} created.`;
}

export async function addWikiPage(client: MoodleClient, args: {
  cmid: number;
  title: string;
  content: string;
  subwikiid?: number;
}): Promise<string> {
  const { cmid, title, content, subwikiid } = args;
  if (!title.trim() || !content.trim()) throw new Error("Wiki page title and content must be nonempty.");
  const wikiid = await instanceFor(client, cmid, "wiki");
  if (subwikiid) {
    const listed = checked(await client.call<{ subwikis: { id: number }[]; warnings?: Warning[] }>(
      "mod_wiki_get_subwikis", { wikiid }), "Checking subwiki");
    if (!listed.subwikis.some((subwiki) => subwiki.id === subwikiid)) {
      throw new Error(`Subwiki ${subwikiid} is not available in wiki cmid ${cmid}.`);
    }
  }
  const result = checked(await client.call<{ pageid: number; warnings?: Warning[] }>("mod_wiki_new_page", {
    wikiid, ...(subwikiid ? { subwikiid } : {}), title, content, contentformat: "html",
  }), "Creating wiki page");
  return `Wiki cmid ${cmid}: page ${result.pageid} created.`;
}

export async function submitSurvey(client: MoodleClient, args: {
  cmid: number;
  answers: { key: string; value: string }[];
}): Promise<string> {
  const { cmid, answers } = args;
  if (!answers.length || new Set(answers.map((answer) => answer.key)).size !== answers.length) {
    throw new Error("Provide one value for each distinct survey answer key.");
  }
  const surveyid = await instanceFor(client, cmid, "survey");
  const result = checked(await client.call<{ status: boolean; warnings?: Warning[] }>(
    "mod_survey_submit_answers", { surveyid, answers }), "Submitting survey");
  if (!result.status) throw new Error("Moodle did not confirm the survey submission.");
  return `Survey cmid ${cmid}: answers submitted.`;
}

export async function postForum(client: MoodleClient, args: {
  cmid: number;
  subject: string;
  message: string;
  parentPostId?: number;
  groupid?: number;
  files?: string[];
}): Promise<string> {
  const { cmid, subject, message, parentPostId, groupid = 0, files } = args;
  if (!subject.trim() || !message.trim()) throw new Error("Forum subject and message must be nonempty.");
  const forumid = await instanceFor(client, cmid, "forum");
  if (parentPostId) {
    const parent = checked(await client.call<{ post: { discussionid: number; capabilities: { reply: boolean } }; warnings?: Warning[] }>(
      "mod_forum_get_discussion_post", { postid: parentPostId }), "Checking parent post");
    const discussion = checked(await client.call<{ forumid: number; warnings?: Warning[] }>(
      "mod_forum_get_discussion_posts", { discussionid: parent.post.discussionid }), "Checking parent discussion");
    if (discussion.forumid !== forumid || !parent.post.capabilities.reply) {
      throw new Error("This post is not replyable in the specified forum.");
    }
  }
  if (files?.length) {
    const access = checked(await client.call<{ cancreateattachment: boolean; warnings?: Warning[] }>(
      "mod_forum_get_forum_access_information", { forumid }), "Checking forum attachment permission");
    if (!access.cancreateattachment) throw new Error("This forum does not allow you to attach files; nothing was uploaded or posted.");
  }
  const attachmentsid = await attachments(client, files);
  const options = attachmentsid ? [{ name: "attachmentsid", value: String(attachmentsid) }] : [];
  if (parentPostId) {
    const result = checked(await client.call<{ postid: number; warnings?: Warning[] }>("mod_forum_add_discussion_post", {
      postid: parentPostId, subject, message, messageformat: 1, options,
    }), "Posting forum reply");
    return `Forum cmid ${cmid}: reply post ${result.postid} created.`;
  }
  const result = checked(await client.call<{ discussionid: number; warnings?: Warning[] }>("mod_forum_add_discussion", {
    forumid, subject, message, groupid, options,
  }), "Starting forum discussion");
  return `Forum cmid ${cmid}: discussion ${result.discussionid} created.`;
}

import {
  cached,
  getConversationMessages,
  getConversations,
  getCourses,
  getDiscussionPosts,
  getDiscussions,
  getForums,
  type Course,
} from "../api.js";
import { fmtDate, fmtRelative, fmtSize, html2line, html2md, table } from "../format.js";
import type { MoodleClient } from "../ws.js";
import { resolveCourse } from "./courses.js";

/**
 * Three levels in one tool: forums of a course, discussions of a forum, posts of
 * a discussion. Which one you get depends on which argument you pass.
 */
export async function forum(
  client: MoodleClient,
  opts: { course?: string | number; forumid?: number; cmid?: number; discussion?: number; limit?: number },
): Promise<string> {
  const limit = opts.limit ?? 15;

  if (opts.discussion) {
    const posts = await getDiscussionPosts(client, opts.discussion);
    if (posts.length === 0) return `Discussion ${opts.discussion} has no readable posts.`;
    const byId = new Map(posts.map((p) => [p.id, p]));
    const depth = (p: (typeof posts)[number]): number => {
      let d = 0;
      let cur = p;
      while (cur.parentid && byId.has(cur.parentid) && d < 12) {
        cur = byId.get(cur.parentid)!;
        d++;
      }
      return d;
    };
    const out = [`# Discussion ${opts.discussion} — ${posts[0]!.subject}`, `${posts.length} post(s)`];
    for (const p of posts.sort((a, b) => a.timecreated - b.timecreated)) {
      const indent = "  ".repeat(depth(p));
      out.push(
        "",
        `${indent}**${p.author?.fullname ?? "?"}** · ${fmtDate(p.timecreated)} · post ${p.id}${p.isdeleted ? " · deleted" : ""}`,
      );
      const body = html2md(p.message, 4000);
      if (body) out.push(body.replace(/^/gm, `${indent}> `));
      for (const a of p.attachments ?? []) {
        out.push(`${indent}> attachment: ${a.filename} (${fmtSize(a.filesize)}) — moodle_download({ url: "${a.fileurl}" })`);
      }
    }
    return out.join("\n");
  }

  if (opts.forumid || opts.cmid) {
    let forumid = opts.forumid;
    if (!forumid && opts.cmid) {
      // Need the course to look forums up by cmid.
      const cm = await client.call<{ cm: { course: number } }>("core_course_get_course_module", { cmid: opts.cmid });
      const forums = await getForums(client, [cm.cm.course]);
      forumid = forums.find((f) => f.cmid === opts.cmid)?.id;
      if (!forumid) throw new Error(`cmid ${opts.cmid} is not a forum in course ${cm.cm.course}.`);
    }
    const discussions = await getDiscussions(client, forumid!, limit);
    if (discussions.length === 0) return `Forum ${forumid} has no discussions.`;
    const rows = discussions.map((d) => [
      d.discussion,
      d.pinned ? `📌 ${d.subject}` : d.subject,
      d.userfullname,
      fmtDate(d.modified),
      d.numreplies,
      d.numunread || "",
    ]);
    return `Forum ${forumid} — ${discussions.length} discussion(s):\n\n${table(["discussion", "subject", "started by", "last activity", "replies", "unread"], rows)}\n\nmoodle_forum({ discussion: <id> }) reads a thread.`;
  }

  const targets: Course[] = opts.course !== undefined
    ? [await resolveCourse(client, opts.course)]
    : (await cached(client, "courses", () => getCourses(client))).filter(
        (c) => !c.enddate || c.enddate * 1000 > Date.now(),
      );

  const forums = await getForums(
    client,
    targets.map((c) => c.id),
  );
  if (forums.length === 0) return "No forums visible in those courses.";
  const names = new Map(targets.map((c) => [c.id, c.shortname]));
  const rows = forums.map((f) => [
    f.id,
    f.cmid,
    names.get(f.course) ?? f.course,
    f.name,
    f.type,
    f.numdiscussions,
    f.unreadpostscount || "",
  ]);
  return `${forums.length} forum(s):\n\n${table(["forumid", "cmid", "course", "name", "type", "discussions", "unread"], rows)}\n\nmoodle_forum({ forumid: <id> }) lists its discussions.`;
}

export async function messages(
  client: MoodleClient,
  opts: { conversation?: number; limit?: number } = {},
): Promise<string> {
  const limit = opts.limit ?? 20;

  if (opts.conversation) {
    const res = await getConversationMessages(client, opts.conversation, limit);
    const who = new Map((res.members ?? []).map((m) => [m.id, m.fullname]));
    const msgs = [...(res.messages ?? [])].sort((a, b) => a.timecreated - b.timecreated);
    if (msgs.length === 0) return `Conversation ${opts.conversation} has no messages.`;
    const out = [`# Conversation ${opts.conversation}`, ""];
    for (const m of msgs) {
      out.push(
        `**${who.get(m.useridfrom) ?? m.useridfrom}** · ${fmtDate(m.timecreated)}`,
        html2md(m.text, 2000).replace(/^/gm, "> "),
        "",
      );
    }
    return out.join("\n");
  }

  const convs = await getConversations(client, limit);
  if (convs.length === 0) return "No conversations.";
  const rows = convs.map((c) => {
    const others = (c.members ?? []).filter((m) => m.id !== client.site.userid).map((m) => m.fullname);
    const last = c.messages?.[0];
    return [
      c.id,
      // `name` is "" rather than null for one-to-one conversations.
      c.name || others.join(", ") || (c.type === 3 ? "(self)" : "(group)"),
      c.unreadcount || "",
      last ? fmtDate(last.timecreated) : "",
      last ? fmtRelative(last.timecreated) : "",
      last ? html2line(last.text, 90) : "",
    ];
  });
  return `${convs.length} conversation(s):\n\n${table(["convid", "with", "unread", "last", "when", "preview"], rows)}\n\nmoodle_messages({ conversation: <convid> }) reads one.`;
}

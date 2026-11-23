import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { cached, getAssignments, getCourseModuleInfo, type ModuleContent } from "../api.js";
import { confineToDownloads, DOWNLOAD_DIR } from "../config.js";
import { fmtSize, table } from "../format.js";
import type { MoodleClient } from "../ws.js";
import { courseSections, resolveCourse } from "./courses.js";

interface Target {
  file: ModuleContent;
  courseid?: number;
  where: string;
}

function safeName(name: string): string {
  return basename(name).replace(/[/\\]/g, "_").replace(/^\.+/, "_") || "download";
}

function nameFromUrl(url: string): string {
  try {
    const p = new URL(url).pathname;
    return safeName(decodeURIComponent(p.split("/").filter(Boolean).pop() ?? "download"));
  } catch {
    return "download";
  }
}

async function targetsForCmid(client: MoodleClient, cmid: number): Promise<Target[]> {
  const cm = await getCourseModuleInfo(client, cmid);
  const out: Target[] = [];

  if (cm.modname === "assign") {
    const assigns = await cached(client, `assigns-${cm.course}`, () => getAssignments(client, [cm.course]));
    const a = assigns.find((x) => x.cmid === cmid);
    for (const f of [...(a?.introattachments ?? []), ...(a?.introfiles ?? [])]) {
      out.push({ file: f, courseid: cm.course, where: `assign "${cm.name}"` });
    }
  }

  const sections = await courseSections(client, cm.course);
  for (const s of sections) {
    const m = s.modules.find((x) => x.id === cmid);
    if (!m) continue;
    for (const c of m.contents ?? []) {
      if (c.type === "file") out.push({ file: c, courseid: cm.course, where: `${m.modname} "${m.name}"` });
    }
  }
  if (out.length === 0) throw new Error(`cmid ${cmid} (${cm.modname} "${cm.name}") exposes no downloadable files.`);
  return out;
}

async function targetsForCourse(client: MoodleClient, ref: string | number): Promise<Target[]> {
  const course = await resolveCourse(client, ref);
  const sections = await courseSections(client, course.id);
  const out: Target[] = [];
  for (const s of sections) {
    for (const m of s.modules) {
      for (const c of m.contents ?? []) {
        if (c.type === "file") out.push({ file: c, courseid: course.id, where: `§${s.section} ${m.modname} "${m.name}"` });
      }
    }
  }
  return out;
}

export interface DownloadOpts {
  url?: string;
  cmid?: number;
  course?: string | number;
  filter?: string;
  dest?: string;
  max?: number;
}

export async function download(client: MoodleClient, opts: DownloadOpts): Promise<string> {
  const max = opts.max ?? 40;
  const dest = opts.dest === undefined ? undefined : confineToDownloads(opts.dest);
  let targets: Target[];

  if (opts.url) {
    targets = [
      {
        file: {
          type: "file",
          filename: nameFromUrl(opts.url),
          filepath: "/",
          filesize: 0,
          fileurl: opts.url,
          timemodified: 0,
        },
        where: "direct url",
      },
    ];
  } else if (opts.cmid) {
    targets = await targetsForCmid(client, opts.cmid);
  } else if (opts.course !== undefined) {
    targets = await targetsForCourse(client, opts.course);
  } else {
    throw new Error("Pass one of: url, cmid, or course.");
  }

  if (opts.filter) {
    const needle = opts.filter.toLowerCase().replace(/^\*|\*$/g, "");
    targets = targets.filter(
      (t) => t.file.filename.toLowerCase().includes(needle) || t.where.toLowerCase().includes(needle),
    );
  }
  if (targets.length === 0) return `Nothing matched${opts.filter ? ` filter "${opts.filter}"` : ""}.`;

  const capped = targets.slice(0, max);
  const results: (string | number)[][] = [];
  let bytes = 0;

  for (const t of capped) {
    const dir = dest ?? join(DOWNLOAD_DIR, client.site.key, String(t.courseid ?? "misc"));
    await mkdir(dir, { recursive: true });
    try {
      const dl = await client.download(t.file.fileurl);
      const name = safeName(t.file.filename || dl.filename || nameFromUrl(t.file.fileurl));
      const path = join(dir, name);
      await writeFile(path, Buffer.from(dl.body));
      bytes += dl.body.byteLength;
      results.push([name, fmtSize(dl.body.byteLength), dl.mimetype.split(";")[0] ?? "", path]);
    } catch (e) {
      results.push([t.file.filename, "FAILED", (e as Error).message.slice(0, 80), ""]);
    }
  }

  const skipped = targets.length - capped.length;
  return [
    `Downloaded ${results.filter((r) => r[1] !== "FAILED").length}/${capped.length} file(s), ${fmtSize(bytes)}${skipped > 0 ? ` — ${skipped} more matched but max=${max}` : ""}.`,
    "",
    table(["file", "size", "type", "path"], results),
    "",
    "Files are on disk now; read or OCR them with whatever tool you like.",
  ].join("\n");
}

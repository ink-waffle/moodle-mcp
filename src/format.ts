import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});
turndown.remove(["script", "style"]);
// Teacher HTML is drowning in colour spans; keep the words, drop the paint.
turndown.addRule("unwrapSpans", {
  filter: ["span", "font"],
  replacement: (content) => content,
});

/** Moodle text fields are HTML soup. Turn them into something readable and small. */
export function html2md(html: string | null | undefined, maxChars = 4000): string {
  if (!html) return "";
  let md: string;
  try {
    md = turndown.turndown(html);
  } catch {
    md = html.replace(/<[^>]+>/g, " ");
  }
  md = md
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (md.length > maxChars) md = `${md.slice(0, maxChars)}\n…[truncated, ${md.length} chars total]`;
  return md;
}

/** Same, squashed onto one line — for tables and list items. */
export function html2line(html: string | null | undefined, maxChars = 300): string {
  const md = html2md(html, maxChars * 4).replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ");
  return md.length > maxChars ? `${md.slice(0, maxChars)}…` : md;
}

export function fmtDate(unix: number | null | undefined): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtRelative(unix: number | null | undefined, now = Date.now()): string {
  if (!unix) return "";
  const diffMin = Math.round((unix * 1000 - now) / 60000);
  const abs = Math.abs(diffMin);
  const unit =
    abs < 60 ? `${abs}m` : abs < 60 * 24 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / (60 * 24))}d`;
  return diffMin >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function fmtSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Compact pipe table; far cheaper in tokens than the equivalent JSON. */
export function table(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) =>
    String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const row of rows) lines.push(`| ${row.map(cell).join(" | ")} |`);
  return lines.join("\n");
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

/**
 * Moodle inflects `dates[].label` by the current time — the same `dataid`
 * "timeopen" renders as "Opens:" before it and "Opened:" after (verified on
 * 4.5.13: 8 modules vs 4 in one fetch), and it is localised to the site
 * language. Key on the stable `dataid` so output does not drift with the clock
 * or come back Finnish; fall back to the label for unknown ids.
 */
const DATE_LABELS: Record<string, string> = {
  allowsubmissionsfromdate: "opens",
  timeopen: "opens",
  timeavailablefrom: "available from",
  submissionstart: "submissions open",
  assessmentstart: "assessments open",
  duedate: "due",
  timeclose: "closes",
  timeavailableto: "available until",
  submissionend: "submissions close",
  assessmentend: "assessments close",
  cutoffdate: "cutoff",
  gradingduedate: "grading due",
  expectedcompletionon: "expected completion",
};

export function dateLabel(date: { label?: string; dataid?: string }): string {
  if (date.dataid && DATE_LABELS[date.dataid]) return DATE_LABELS[date.dataid]!;
  return decodeEntities(date.label ?? "date").replace(/:\s*$/, "").toLowerCase();
}

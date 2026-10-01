import type { MoodleClient } from "../ws.js";

/* Raw access excludes view/write calls; some get calls still have Moodle-side effects. */
const READ_VERBS = /_(get|search|is|can|check)_/;

export function assertReadOnly(fn: string): void {
  if (!READ_VERBS.test(fn)) {
    throw new Error(
      `Refusing to call ${fn}: moodle_call only allows names containing _get_, _search_, _is_, _can_ or _check_. Use the dedicated submission tools for writes.`,
    );
  }
}

export async function rawCall(
  client: MoodleClient,
  fn: string,
  params: Record<string, unknown> = {},
  maxChars = 40_000,
): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(fn)) throw new Error(`"${fn}" is not a valid web-service function name.`);
  assertReadOnly(fn);
  const data = await client.call(fn, params);
  const json = JSON.stringify(data, null, 1);
  if (json.length > maxChars) {
    return `${json.slice(0, maxChars)}\n…[truncated: ${json.length} chars total. Narrow the parameters.]`;
  }
  return json;
}

export async function listFunctions(client: MoodleClient, filter?: string): Promise<string> {
  const info = await client.call<{ functions: { name: string }[] }>("core_webservice_get_site_info");
  let names = info.functions.map((f) => f.name).sort();
  if (filter) {
    const needle = filter.toLowerCase();
    names = names.filter((n) => n.includes(needle));
  }
  return `${names.length} function(s)${filter ? ` matching "${filter}"` : ""} on ${client.site.key}:\n${names.join("\n")}`;
}

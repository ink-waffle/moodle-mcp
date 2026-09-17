import type { MoodleClient } from "../ws.js";

/**
 * v1 is read-only. An allowlist of read verbs is used rather than a denylist of
 * write verbs: a denylist both misses new mutating functions and trips over
 * innocent names (core_enrol_get_users_courses contains "enrol"). Note that
 * `mod_*_view_*` calls are writes — they mark activities complete, which can
 * move a grade — so they are excluded here on purpose.
 *
 * The allowlist is a strong heuristic, not a guarantee: a few core functions
 * write despite a `_get_` name. Verified on 4.5.13 —
 * `mod_assign_get_submission_status` inserts an `assign_submission` row with
 * status "new" for the calling user if none exists. That is benign (opening the
 * activity in a browser does the same, and status "new" is not a submission),
 * but it means "read-only" here describes intent, not an enforced property.
 */
const READ_VERBS = /_(get|search|is|can|check)_/;

export function assertReadOnly(fn: string): void {
  if (!READ_VERBS.test(fn)) {
    throw new Error(
      `Refusing to call ${fn}: read-only v1 only allows functions whose name contains _get_, _search_, _is_, _can_ or _check_. Changing things is out of scope for this server — do it in a browser.`,
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

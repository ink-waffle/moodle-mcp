# @ink-waffle/moodle-mcp

Use Moodle from an MCP client: read courses, activities, deadlines, grades and materials; submit assignments, quizzes and other supported activities through Moodle's web-service API.

## Install

Configure this MCP in your MCP client (Claude Code, Windsurf, Cursor, Zed, OpenCode, or any other MCP-capable editor/agent):

```bash
mcp add moodle -- npx -y @ink-waffle/moodle-mcp
```

(Assuming `mcp` is your client's MCP client management CLI — adjust for your editor.)

Ask your agent to run `moodle_connect` with your Moodle site. On SSO sites, log in in the browser tab it opens, then call `moodle_connect` again. If your site accepts username/password login, pass those directly instead.

## Tools

| tool | use it for |
|---|---|
| `moodle_connect`, `moodle_status`, `moodle_disconnect` | connect and manage sites |
| `moodle_courses`, `moodle_outline`, `moodle_activity` | inspect courses and activities |
| `moodle_deadlines`, `moodle_grades` | see due work and grades |
| `moodle_notifications`, `moodle_whatsnew` | see recent changes |
| `moodle_search` | search cached course content |
| `moodle_forum`, `moodle_messages` | read discussions and messages |
| `moodle_download` | download files |
| `moodle_upload_draft` | upload files to a Moodle draft item for a supported activity |
| `moodle_assignment_start`, `moodle_assignment_submit`, `moodle_assignment_finalize` | start a timed assignment, save files/text, finalize a draft |
| `moodle_quiz_start`, `moodle_quiz_page`, `moodle_quiz_save`, `moodle_quiz_process` | start/resume, read question HTML, save answers, finish an attempt |
| `moodle_choice_submit`, `moodle_workshop_submit`, `moodle_workshop_assess`, `moodle_forum_post` | submit choices, workshop work/reviews, and forum posts |
| `moodle_feedback_*`, `moodle_lesson_*` | navigate and answer multi-page activities |
| `moodle_glossary_add`, `moodle_database_add`, `moodle_wiki_add_page`, `moodle_survey_submit` | create other supported activity submissions |
| `moodle_call`, `moodle_functions` | access available **read-only** API functions and list site capabilities |

Writes use the site's web-service token, not the browser; file uploads require the site's mobile web service to permit uploads. `moodle_call` remains read-only. Inspect `moodle_activity` before a write: saving without a draft stage can immediately submit, and starting/finishing a quiz or lesson may consume a graded attempt. A submission statement is the declaration a student must accept when submitting work; no-draft assignments requiring one must be completed in Moodle's UI because the save API cannot record acceptance. `moodle_activity` reports known browser-dependent activity types and quiz question types; `moodle_quiz_page` also warns that HTML may omit the usable visual/interactive context. **These checks cannot rule out embedded media, custom scripts, or external content.** When an activity cannot be understood through the API, use another browser tool if appropriate or ask the student; this MCP does not automate browser exercise runtimes.

## Shared browser

This MCP is designed to run beside `@ink-waffle/aplus-mcp` and `@ink-waffle/sisu-mcp`. All three use the sibling `@ink-waffle/study-browser` package when browser access is needed.

By default it creates and reuses one isolated Chrome profile:

```text
~/.chrome-profiles-mcp/study-automation-profile
```

It starts Chrome with a local **CDP** endpoint when necessary. Sibling MCP processes reuse that browser instead of starting conflicting copies. The browser stays open until you close it.

Works on macOS, Windows, and Linux.

## Alternative setups

### One HTTP server, many clients

```bash
# Run as a persistent service (systemd, Windows Service, launchd, etc.):
npx -y @ink-waffle/moodle-mcp --port 8933
```

```bash
# Then configure your MCP client to connect via HTTP:
mcp add --transport http moodle http://127.0.0.1:8933/mcp
```

### Your own Chrome

```bash
npx -y @ink-waffle/moodle-mcp --cdp http://127.0.0.1:9222
```

The MCP only attaches to an explicit CDP endpoint; it never starts or closes that browser. Use `MOODLE_MCP_CDP` instead of `--cdp` with a service manager.

## Local data

Tokens and cached data live in `~/.moodle-mcp/`. Treat `config.json` as a password file. Downloads go to `~/.moodle-mcp/files/` unless you pass `dest`.

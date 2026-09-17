# @ink-waffle/moodle-mcp

Use Moodle from an MCP client: courses, activities, deadlines, grades, forums, messages, notifications, search, and downloads. It is read-only.

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
| `moodle_call`, `moodle_functions` | access available read-only API functions |

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

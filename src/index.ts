#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeContext } from "./browser.js";
import { closeAllSessions, serveHttp } from "./http.js";
import { createServer } from "./server.js";

/**
 * Two transports, same tools.
 *
 *   moodle-mcp                  stdio — the client owns the process (npx-friendly)
 *   moodle-mcp --port 8933      HTTP  — one shared process every client connects to
 *
 * HTTP is the better shape when several agent sessions run at once: a single
 * owner for the login browser, one warm cache, and no process-per-session pile-up.
 */
const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

const port = flag("--port") ?? process.env.MOODLE_MCP_PORT;
const host = flag("--host") ?? process.env.MOODLE_MCP_HOST ?? "127.0.0.1";
const cdp = flag("--cdp");
if (cdp) process.env.MOODLE_MCP_CDP = cdp;

async function shutdown(): Promise<void> {
  await closeAllSessions().catch(() => {});
  await closeContext().catch(() => {}); // leave no orphan Chrome behind
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void shutdown());

if (port) {
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`Invalid --port ${port}`);
    process.exit(1);
  }
  await serveHttp(host, parsed);
} else {
  await createServer().connect(new StdioServerTransport());
}

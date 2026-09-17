import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

/**
 * One process, many clients. Every MCP session (and its own McpServer) over
 * Streamable HTTP runs in this shared process — one shared managed browser,
 * one warm cache, and nothing lingers when a client dies badly.
 */
const sessions = new Map<string, StreamableHTTPServerTransport>();

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  respond(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

export async function serveHttp(host: string, port: number): Promise<void> {
  const allowedHosts = [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];

  const http = createHttpServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];

      if (path === "/health") {
        respond(res, 200, { ok: true, server: "moodle-mcp", sessions: sessions.size, uptime: process.uptime() });
        return;
      }
      if (path !== "/mcp") {
        respond(res, 404, { error: "not found", hint: "MCP endpoint is /mcp" });
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

      try {
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          let transport = sid ? sessions.get(sid) : undefined;

          if (!transport) {
            if (sid) {
              // The client is resuming a session this process no longer knows —
              // it restarted. Say so precisely instead of a bare 404.
              rpcError(res, 404, -32001, "Unknown MCP session (the moodle-mcp server restarted). Reconnect to start a new one.");
              return;
            }
            if (!isInitializeRequest(body)) {
              rpcError(res, 400, -32000, "Expected an initialize request to open a new session.");
              return;
            }
            const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              enableDnsRebindingProtection: true,
              allowedHosts,
              onsessioninitialized: (id) => {
                sessions.set(id, created);
                console.error(`[moodle-mcp] session ${id.slice(0, 8)} opened (${sessions.size} active)`);
              },
              onsessionclosed: (id) => {
                sessions.delete(id);
                console.error(`[moodle-mcp] session ${id.slice(0, 8)} closed (${sessions.size} active)`);
              },
            });
            created.onclose = () => {
              if (created.sessionId) sessions.delete(created.sessionId);
            };
            await createServer().connect(created);
            transport = created;
          }
          await transport.handleRequest(req, res, body);
          return;
        }

        if (req.method === "GET" || req.method === "DELETE") {
          const transport = sid ? sessions.get(sid) : undefined;
          if (!transport) {
            rpcError(res, 404, -32001, "Unknown or missing MCP session id.");
            return;
          }
          await transport.handleRequest(req, res);
          return;
        }

        res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
      } catch (e) {
        console.error("[moodle-mcp] request failed:", e);
        if (!res.headersSent) rpcError(res, 500, -32603, `Internal error: ${(e as Error).message}`);
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, resolve);
  });
  console.error(`[moodle-mcp] listening on http://${host}:${port}/mcp  (health: /health)`);
}

export async function closeAllSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map((t) => t.close().catch(() => {})));
  sessions.clear();
}

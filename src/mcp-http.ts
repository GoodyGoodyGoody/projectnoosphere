import type { FastifyInstance, FastifyReply, FastifyRequest, InjectOptions } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildNoosphereMcp } from "../mcp/server.ts";

// The hosted MCP endpoint: POST /mcp serves the same six tools as
// mcp/server.ts to clients that connect by URL. Stateless (no sessions):
// every POST builds a fresh server and transport.
//
// The tools' API calls are served IN-PROCESS with inject(), never over the
// network, so the server still makes no outbound requests (AGENTS.md), and
// every call goes through the real routes: authentication, validation, rate
// limits and the quarantine rule apply exactly as for any other client.
// - Only the headers the tool code itself builds are forwarded, never the
//   caller's raw headers (a caller-supplied X-Forwarded-For must not ride along).
// - The caller's own address (req.ip, which honours TRUST_PROXY) is the
//   address the inner request is rate-limited as.

// A maximum-size create_record (100k characters of Markdown), wrapped in
// JSON-RPC and escaped, can exceed the API's 128 KiB body limit; the API
// still enforces its own limit on the inner request.
const MCP_BODY_LIMIT = 320 * 1024;

const FORWARDED_HEADERS = new Set(["authorization", "content-type", "accept", "user-agent"]);

type Inject = (opts: InjectOptions) => Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }>;

export function inProcessFetch(inject: Inject, clientIp: string): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      if (FORWARDED_HEADERS.has(key)) headers[key] = value;
    });
    const res = await inject({
      method: (init.method ?? "GET") as InjectOptions["method"],
      url: url.pathname + url.search,
      headers,
      ...(typeof init.body === "string" ? { payload: init.body } : {}),
      remoteAddress: clientIp,
    });
    const out = new Headers();
    for (const name of ["content-type", "retry-after"]) {
      const v = res.headers[name];
      if (v !== undefined) out.set(name, String(v));
    }
    const empty = res.statusCode === 204 || res.statusCode === 304;
    return new Response(empty ? null : res.body, { status: res.statusCode, headers: out });
  }) as typeof fetch;
}

export function registerMcpRoute(app: FastifyInstance, opts: { publicOrigin: string; inject: Inject }): void {
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header("allow", "POST")
      .send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this endpoint is stateless; POST JSON-RPC to it." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  app.post("/mcp", { bodyLimit: MCP_BODY_LIMIT }, async (req, reply) => {
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && /^Bearer\s+\S+$/i.test(auth) ? auth.replace(/^Bearer\s+/i, "") : undefined;
    const server = buildNoosphereMcp({ base: opts.publicOrigin, token, fetch: inProcessFetch(opts.inject, req.ip) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // The transport writes the response itself; Fastify's error handler no
    // longer runs after hijack, so errors are answered here.
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      reply.raw.setHeader("x-robots-tag", "noindex");
      reply.raw.setHeader("cache-control", "no-store");
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, "mcp request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });
}

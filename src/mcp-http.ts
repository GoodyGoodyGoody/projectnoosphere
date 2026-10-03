import type { FastifyInstance, InjectOptions } from "fastify";
import * as Sentry from "@sentry/node";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildNoosphereMcp } from "../mcp/server.ts";
import { triageMcpError } from "./error-status.ts";

// The hosted MCP endpoint: /mcp serves the same six tools as mcp/server.ts to
// clients that connect by URL. createMcpHandler (SDK v2) speaks protocol
// revision 2026-07-28 AND falls back to stateless 2025-era serving, per
// request. On SDK v1 every 2026-07-28 client got "Unsupported protocol
// version" (Sentry PROJECTNOOSPHERE-5, 7 clients on the first night listed).
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

// What each request's server needs to know about its caller. It rides in the
// SDK's authInfo, which reaches the factory untouched on both protocol eras.
type Caller = { token: string; clientIp: string } & Record<string, unknown>;

// Where requests the SDK rejects before any server exists are reported. Sentry's
// MCP integration hooks McpServer, so it never sees these, and they include the
// one worth knowing about: a client on a protocol revision newer than ours.
export type McpReporter = (error: Error, level: "warning" | "error") => void;
const sentryReport: McpReporter = (error, level) => {
  Sentry.captureException(error, { level, tags: { mcp: "rejected_request" } });
};

export function registerMcpRoute(app: FastifyInstance, opts: { publicOrigin: string; inject: Inject; report?: McpReporter }): void {
  const report = opts.report ?? sentryReport;
  const handler = createMcpHandler(({ authInfo }) => {
    const caller = authInfo?.extra as Partial<Caller> | undefined;
    // Never fall back to a default address: rate limits would silently treat
    // every client as one.
    if (!caller?.clientIp) throw new Error("mcp: caller address missing from authInfo");
    return buildNoosphereMcp({
      base: opts.publicOrigin,
      token: caller.token || undefined,
      fetch: inProcessFetch(opts.inject, caller.clientIp),
    });
  }, {
    onerror: (error) => {
      const verdict = triageMcpError(error.message);
      if (verdict !== "drop") report(error, verdict === "warn" ? "warning" : "error");
    },
  });
  const node = toNodeHandler(handler);

  // GET and DELETE go to the SDK too: it answers them for each protocol era.
  app.route({ method: ["GET", "POST", "DELETE"], url: "/mcp", bodyLimit: MCP_BODY_LIMIT, handler: async (req, reply) => {
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && /^Bearer\s+\S+$/i.test(auth) ? auth.replace(/^Bearer\s+/i, "") : "";
    const caller: Caller = { token, clientIp: req.ip };
    // The SDK writes the response itself; Fastify's error handler no longer
    // runs after hijack, so errors are answered here.
    reply.hijack();
    try {
      reply.raw.setHeader("x-robots-tag", "noindex");
      reply.raw.setHeader("cache-control", "no-store");
      // The SDK answers GET and DELETE on this stateless endpoint with 405 but
      // no Allow header, which HTTP requires on a 405.
      if (req.method !== "POST") reply.raw.setHeader("allow", "POST");
      const raw = Object.assign(req.raw, { auth: { token, clientId: "noosphere-mcp", scopes: [], extra: caller } });
      await node(raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, "mcp request failed");
      // Hijacked: neither the app's error handler nor Sentry's Fastify hook sees this.
      Sentry.captureException(err, { tags: { request_id: req.id } });
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  } });
}

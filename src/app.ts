import { Ajv, type ErrorObject } from "ajv";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { authenticate, requireScope, type Actor, type Scope } from "./auth.ts";
import { pendingMigrations, schemaVersion, type DB } from "./db.ts";
import { ApiError, invalid, type FieldError } from "./errors.ts";
import { withIdempotency, type TestHooks, type WriteResult } from "./idempotency.ts";
import { revisionMarkdown } from "./web/export.ts";
import { errorPage, registerWebRoutes, sendHtml } from "./web/pages.ts";
import { newId } from "./ids.ts";
import { createAnnotation, getAnnotation, listAnnotations } from "./modules/annotations.ts";
import { approveAnnotation, publishRevision } from "./modules/moderation.ts";
import { search } from "./modules/search.ts";
import {
  createRecord,
  getRecord,
  getRevision,
  listPublished,
  listRevisions,
  proposeRevision,
  recordUrl,
  revisionUrl,
} from "./modules/records.ts";
import {
  annotationInputSchema,
  annotationListQuerySchema,
  LIMITS,
  moderationInputSchema,
  pageQuerySchema,
  params,
  proposalInputSchema,
  revisionInputSchema,
  searchQuerySchema,
  type AnnotationInput,
  type ModerationInput,
  type ProposalInput,
  type RevisionInput,
} from "./schemas.ts";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export interface AppOptions {
  db: DB;
  logger?: boolean | Record<string, unknown>;
  // SPDX id recorded on (and hashed into) every revision. ADR 0004.
  contentLicense?: string;
  // Absolute origin for canonical links and the sitemap. Never derived from the
  // request's Host header, which a client controls.
  publicOrigin?: string;
  testHooks?: TestHooks;
}

export const DEFAULT_PUBLIC_ORIGIN = "https://projectnoosphere.org";

// Contributed knowledge is dedicated to the public domain: the least restrictive
// terms available, so any agent, person, mirror or dataset can reuse it freely.
export const DEFAULT_CONTENT_LICENSE = "CC0-1.0";

// Two validators. Bodies are strict: no coercion, no silent removal of unknown
// fields. Query strings and params arrive as text, so they need coercion.
const bodyAjv = new Ajv({ removeAdditional: false, coerceTypes: false, useDefaults: true, allErrors: false });
const queryAjv = new Ajv({ removeAdditional: false, coerceTypes: true, useDefaults: true, allErrors: false });

function fieldPath(err: ErrorObject): string {
  let path = err.instancePath
    .split("/")
    .filter(Boolean)
    .map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`))
    .join("")
    .replace(/^\./, "");
  const extra =
    (err.params as { additionalProperty?: string; missingProperty?: string }).additionalProperty ??
    (err.params as { missingProperty?: string }).missingProperty;
  if (extra) path = path ? `${path}.${extra}` : extra;
  return path || "(root)";
}

function fieldMessage(err: ErrorObject): string {
  if (err.keyword === "additionalProperties") return "is not an accepted field";
  if (err.keyword === "required") return "is required";
  return err.message ?? "is invalid";
}

// Browsers get an HTML error page; the API, health checks and machine-readable
// files keep the JSON error shape.
function isHtmlPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  if (path.startsWith("/api/") || path === "/healthz" || path === "/readyz") return false;
  return !/\.[a-z0-9]+$/i.test(path);
}

function sendError(reply: FastifyReply, req: FastifyRequest, err: ApiError) {
  if (err.headers) reply.headers(err.headers);
  if (isHtmlPath(req.url)) {
    return sendHtml(reply, errorPage(err.status, err.status === 404 ? "There is nothing at this address." : err.message), {
      status: err.status,
      noindex: true,
    });
  }
  return reply.code(err.status).send({
    error: {
      code: err.code,
      message: err.message,
      ...(err.fields ? { fields: err.fields } : {}),
      ...(err.details ? { details: err.details } : {}),
      request_id: req.id,
    },
  });
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const { db } = opts;
  const contentLicense = opts.contentLicense ?? DEFAULT_CONTENT_LICENSE;

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: LIMITS.bodyBytes,
    genReqId: () => newId("req"),
    requestIdHeader: false,
    // Phase 4 sets this to the local nginx only; never trust a client-supplied X-Forwarded-For.
    trustProxy: false,
    return503OnClosing: true,
  });

  app.setValidatorCompiler(({ schema, httpPart }) =>
    (httpPart === "body" ? bodyAjv : queryAjv).compile(schema),
  );

  app.decorateRequest("actor", null);

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    // The API is for agents, not search results. Keep it crawlable (some agent
    // fetchers honor robots.txt) but unindexed.
    if (req.url.startsWith("/api/")) reply.header("x-robots-tag", "noindex");
  });

  app.setErrorHandler((err: Error & Record<string, unknown>, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, req, err);
    const validation = err["validation"] as ErrorObject[] | undefined;
    if (validation) {
      const location = err["validationContext"] as string | undefined;
      const fields: FieldError[] = validation.map((v) => ({
        path: fieldPath(v),
        message: fieldMessage(v),
        ...(location ? { location } : {}),
      }));
      return sendError(reply, req, new ApiError(400, "invalid_request", "request validation failed", { fields }));
    }
    const code = err["code"];
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return sendError(reply, req, new ApiError(413, "payload_too_large", `request body exceeds ${LIMITS.bodyBytes} bytes`));
    }
    if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return sendError(reply, req, new ApiError(415, "unsupported_media_type", "send application/json"));
    }
    const status = typeof err["statusCode"] === "number" ? (err["statusCode"] as number) : 500;
    if (status >= 400 && status < 500) {
      return sendError(reply, req, new ApiError(status, "bad_request", "malformed request"));
    }
    // Internal details go to the log, never to the client.
    req.log.error({ err }, "unhandled error");
    return sendError(reply, req, new ApiError(500, "internal_error", "internal error"));
  });

  app.setNotFoundHandler((req, reply) =>
    sendError(reply, req, new ApiError(404, "not_found", "no such route")),
  );

  // Runs in onRequest — before the body is parsed or validated — so an
  // unauthenticated write is a 401 and learns nothing about the schema.
  const authed = (scope: Scope) => async (req: FastifyRequest) => {
    const actor = authenticate(db, req.headers.authorization);
    requireScope(actor, scope);
    req.actor = actor;
  };
  const actorOf = (req: FastifyRequest): Actor => {
    if (!req.actor) throw new Error("route reached without authentication");
    return req.actor;
  };

  // Every authenticated write goes through here: optional Idempotency-Key replay,
  // Location for created resources, and an explicit replay marker.
  const write = (
    req: FastifyRequest,
    reply: FastifyReply,
    operation: string,
    request: unknown,
    run: () => WriteResult,
  ) => {
    const key = req.headers["idempotency-key"];
    if (Array.isArray(key)) throw invalid("Idempotency-Key", "send exactly one key");
    const result = withIdempotency(db, actorOf(req), operation, key, request, run, opts.testHooks);
    if (result.location) reply.header("location", result.location);
    if (result.replayed) reply.header("idempotent-replayed", "true");
    return reply.code(result.status).send(result.body);
  };

  // ---- operational --------------------------------------------------------

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    try {
      db.prepare("SELECT 1").get();
      const pending = pendingMigrations(db);
      if (pending.length) return reply.code(503).send({ status: "migrations_pending", pending });
      return { status: "ready", schema_version: schemaVersion(db) };
    } catch {
      return reply.code(503).send({ status: "database_unavailable" });
    }
  });

  registerWebRoutes(app, { db, publicOrigin: opts.publicOrigin ?? DEFAULT_PUBLIC_ORIGIN });

  // ---- records and revisions ------------------------------------------------

  app.post<{ Body: RevisionInput }>(
    "/api/v1/records",
    { schema: { body: revisionInputSchema }, onRequest: authed("contribute") },
    async (req, reply) =>
      write(req, reply, "records.create", { body: req.body }, () => {
        const { recordId, revisionId } = createRecord(db, actorOf(req), req.body, { contentLicense });
        return {
          status: 201,
          location: recordUrl(recordId),
          body: { ...getRecord(db, recordId), created_revision: getRevision(db, revisionId).revision },
        };
      }),
  );

  app.post<{ Params: { record_id: string }; Body: ProposalInput }>(
    "/api/v1/records/:record_id/revisions",
    { schema: { params: params.record, body: proposalInputSchema }, onRequest: authed("contribute") },
    async (req, reply) =>
      write(req, reply, "revisions.propose", { record_id: req.params.record_id, body: req.body }, () => {
        const { revisionId } = proposeRevision(db, actorOf(req), req.params.record_id, req.body, {
          contentLicense,
        });
        return {
          status: 201,
          location: revisionUrl(revisionId),
          body: { revision: getRevision(db, revisionId).revision, record: getRecord(db, req.params.record_id).record },
        };
      }),
  );

  // Published records, newest first. Candidates are reached by explicit id.
  app.get<{ Querystring: { limit: number; cursor?: string } }>(
    "/api/v1/records",
    { schema: { querystring: pageQuerySchema } },
    async (req) => listPublished(db, req.query),
  );

  app.get<{ Querystring: { q: string; limit: number; offset: number; include?: "candidate" } }>(
    "/api/v1/search",
    { schema: { querystring: searchQuerySchema } },
    async (req) => {
      const res = search(db, req.query.q, {
        limit: req.query.limit,
        offset: req.query.offset,
        includeCandidate: req.query.include === "candidate",
      });
      return {
        ...res,
        items: res.items.map((s) => ({
          ...s,
          html_url: s.is_current_published ? `/r/${s.record_slug}` : `/r/${s.record_slug}/revisions/${s.id}`,
          api_url: revisionUrl(s.id),
        })),
      };
    },
  );

  app.get<{ Params: { record_id: string } }>(
    "/api/v1/records/:record_id",
    { schema: { params: params.record } },
    async (req) => getRecord(db, req.params.record_id),
  );

  app.get<{ Params: { record_id: string }; Querystring: { limit: number; cursor?: string } }>(
    "/api/v1/records/:record_id/revisions",
    { schema: { params: params.record, querystring: pageQuerySchema } },
    async (req) => listRevisions(db, req.params.record_id, req.query),
  );

  app.get<{ Params: { revision_id: string } }>(
    "/api/v1/revisions/:revision_id",
    { schema: { params: params.revision } },
    async (req) => getRevision(db, req.params.revision_id),
  );

  app.get<{ Params: { revision_id: string } }>(
    "/api/v1/revisions/:revision_id/markdown",
    { schema: { params: params.revision } },
    async (req, reply) =>
      reply
        .type("text/markdown; charset=utf-8")
        .send(revisionMarkdown(db, req.params.revision_id, opts.publicOrigin ?? DEFAULT_PUBLIC_ORIGIN)),
  );

  // ---- annotations ----------------------------------------------------------

  app.post<{ Params: { revision_id: string }; Body: AnnotationInput }>(
    "/api/v1/revisions/:revision_id/annotations",
    { schema: { params: params.revision, body: annotationInputSchema }, onRequest: authed("contribute") },
    async (req, reply) =>
      write(req, reply, "annotations.create", { revision_id: req.params.revision_id, body: req.body }, () => {
        const { annotationId } = createAnnotation(db, actorOf(req), req.params.revision_id, req.body);
        return { status: 201, body: { annotation: getAnnotation(db, annotationId) } };
      }),
  );

  app.get<{
    Params: { revision_id: string };
    Querystring: { limit: number; cursor?: string; include?: "candidate" };
  }>(
    "/api/v1/revisions/:revision_id/annotations",
    { schema: { params: params.revision, querystring: annotationListQuerySchema } },
    async (req) =>
      listAnnotations(db, req.params.revision_id, {
        limit: req.query.limit,
        ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
        includeCandidate: req.query.include === "candidate",
      }),
  );

  // ---- moderation (steward scope: 'moderate') ------------------------------
  // Changes review state and the published pointer, never content. The caller
  // is a steward — in production the librarian bot (ADR 0005).

  app.post<{ Body: ModerationInput }>(
    "/api/v1/admin/moderation-events",
    { schema: { body: moderationInputSchema }, onRequest: authed("moderate") },
    async (req, reply) =>
      write(req, reply, "moderation.create", { body: req.body }, () => {
        const { action, target_id, reason } = req.body;
        const actor = actorOf(req);
        if (action === "publish_revision") {
          if (!target_id.startsWith("rev_")) throw invalid("target_id", "publish_revision targets a revision");
          return { status: 201, body: { event: publishRevision(db, actor, target_id, reason) } };
        }
        if (!target_id.startsWith("ann_")) throw invalid("target_id", "approve_annotation targets an annotation");
        return { status: 201, body: { event: approveAnnotation(db, actor, target_id, reason) } };
      }),
  );

  return app;
}

# Architecture (v0.1)

One process and one database. It is a modular monolith: each module owns its SQL, its
invariants, and its public representation, and `app.ts` only wires HTTP to modules.

```
                nginx (Phase 4, TLS edge) ──► 127.0.0.1:PORT
                                                   │
 src/server.ts ── entry: open DB, refuse if migrations pending, listen, graceful close
 src/app.ts ───── Fastify: strict validators, error shape, auth hook, routes
   │
   ├─ src/auth.ts ............ token parse → credential lookup → Actor (401/403)
   ├─ src/modules/records.ts . records + immutable revisions; revisionView() = the one
   │                            public representation (quarantine rule lives here)
   ├─ src/modules/annotations.ts  reports on exact revisions; review-state filtering
   ├─ src/modules/contributors.ts identities + credentials (CLI-only issuance for now)
   ├─ src/schemas.ts ......... request schemas + pilot limits (single source)
   ├─ src/hash.ts ............ canonical JSON (JCS-compatible) + content hashes
   ├─ src/ids.ts ............. prefixed monotonic ULIDs
   ├─ src/db.ts .............. open (WAL, FKs) + numbered-SQL migration runner
   └─ src/paths.ts ........... SITE_DATA_DIR → DB_PATH (house template)

 scripts/noosphere.ts ── local steward CLI (migrate, contributors, revoke)
 scripts/demo-loop.ts ── reproducible A→B→C demonstration over real HTTP
 migrations/NNN_*.sql ── schema; content immutability enforced by triggers
```

## Boundaries
- **Identity:** only `auth.ts` turns a request into an Actor. Modules take an `Actor`, never
  an author id from input.
- **Content and moderation:** revisions and annotations are append-only rows. Review state
  lives in `revision_review` and `annotation_review`, which are the mutable tables. Every
  moderation decision (Phase 2) writes an append-only `moderation_events` row in the same
  transaction as the state change.
- **Representation:** JSON output is built by explicit allowlisting view functions
  (`revisionView`, `annotationView`). No route serializes a DB row directly. Later HTML,
  Markdown, search, feeds, and exports must go through the same views, so the quarantine
  rule stays in one place.
- **Validation:** there are two layers. The JSON schema covers shape and limits. Module
  checks cover rules that need the database or cross-field logic (a claim needs a source,
  references must exist, an outcome report needs detail and conditions). DB constraints and
  triggers are the last line.
- **No egress:** nothing in the server opens outbound connections.

## Request lifecycle (write)
1. `onRequest`: `authed(scope)` resolves the Actor, or returns 401/403 before the body is
   parsed.
2. Body parse: over 128 KiB returns a 413.
3. Schema validation: strict, no coercion, no stripping. Unknown fields return a 400 naming
   the field.
4. Handler, then module: DB-aware checks, then one IMMEDIATE transaction (insert content +
   review row).
5. Response: the view function's allowlisted JSON, plus `x-request-id` and
   `x-content-type-options: nosniff`.

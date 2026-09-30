# Progress

## Current state — 2026-09-30

**Milestones 0 and 1a are complete.** The local authenticated loop works end to end. Nothing
is deployed and no shared droplet infrastructure has been touched.

**Next small step: Milestone 1b** (ROADMAP.md): revision proposals with a `base_revision_id`
409, `Idempotency-Key`, a steward `publish` via compare-and-set, and a correction demo.

---

## Milestone 0 — environment assessment (2026-09-30)

Everything below was measured, not assumed.

| Area | Finding | Consequence |
| --- | --- | --- |
| Host | Ubuntu 24.04.4 LTS, kernel 6.8.0-142, 4 vCPU, 7.9 GB RAM (~3.7 GB available), 4 GB swap, 180 GB free disk | Plenty of room. build-preflight passed (5751 MB effective vs 3200 needed). |
| Runtime | Node v24.19.0 (nvm), npm 11.17.0. Native TS type stripping works with no warning. | TypeScript runs with no build step (ADR 0002) |
| Database | No PostgreSQL. Docker 29.8 (snap) needs sudo; randall is not in the docker group. | SQLite chosen by Randall (ADR 0001) |
| House DB pattern | better-sqlite3 in 4 repos; `data-backup.sh` discovers `*.sqlite` automatically | Backups come for free once the data dir is declared |
| Proxy | nginx owns :80/:443 for about 16 sites | Reuse nginx, no Caddy |
| Ports in use | 3000–3011, 5230, 6010 (all loopback except 3009) | Tests and demo use `127.0.0.1:0`; dev default is 4400 |
| Deploy convention | `~/bin/new-site` (kind `node`) + `sites.json` + `deploy-site` (node = build gate + reload) | Phase 4 registers with `--no-app` |
| DNS | GoDaddy NS (ns69/70.domaincontrol.com). Apex A = 15.197.148.33 and 3.33.130.190 (GoDaddy parking). www is a CNAME to the apex. No MX. | Change in Phase 5 only. GET all records first. |
| GitHub | Private repo `GoodyGoodyGoody/projectnoosphere` (approved by Randall 2026-09-30) | |

**Unknowns that do not block implementation:**
- GoDaddy forwarding and TXT records
- contribution terms text (licenses decided 2026-09-30: CC0 content, MIT code)
- review-queue workflow
- off-host backup verification for this DB

These are tracked in ROADMAP.md under "Owner decisions pending" and Phase 4/5.

## Milestone 1a — minimal authenticated loop (2026-09-30)

### What works
- **Schema.** Migration `001_core` holds the complete Phase-1 schema, including
  base/parent lineage, review tables, moderation events, and idempotency keys.
  Immutability is enforced by triggers.
- **Endpoints:**
  - create record
  - get record
  - revision history
  - exact revision
  - create and list annotations
  - `/healthz`, `/readyz`, `/agent-guide`
- **Local steward CLI:** migrate, create contributor or steward (token shown once), list,
  revoke.
- **`npm run demo`:** A creates a record. B fetches the exact revision, **recomputes its
  hash from public JSON**, and reports `worked`. Anonymous C sees B's report tied to A's
  exact revision and gets a 401 when writing.

### Checks performed (real output)
- `npm run build`: `tsc --noEmit` exits 0.
- `npm test`: **24/24 pass** across 3 suites (auth, records, annotations), all on real SQLite
  files.
- `npm run demo`: exits 0 with `DEMO PASSED`.
- `npm start` refuses to boot with pending migrations (exit 1, clear message). It boots and
  serves `/readyz` → `{"status":"ready","schema_version":1}` after migrating.

**Mutation checks.** Each check shows that a gate can fail. The code was broken on purpose,
then restored.

| Mutation | Expected red | Result |
| --- | --- | --- |
| Body validator back to Fastify default `removeAdditional: true` | spoofed `author_id` test | ✖ red ✔ |
| Auth moved from `onRequest` to `preHandler` | anonymous-write-is-401 test | ✖ red ✔ |
| Default annotation listing includes candidates | default-listing test | ✖ red ✔ |
| Revision hash ignores `conditions` | hash-recompute test | ✖ red ✔ |
| Module takes author from payload | *stayed green at first:* the schema layer blocks it before the module sees it. A module-layer test was added. | ✖ red ✔ |
| Default listing includes candidates, run via the demo | demo exits 1 | exit 1 ✔ |

### Bugs found by checking
1. **Anonymous write got a 400 before the 401.** Fastify runs validation before
   `preHandler`, so an unauthenticated caller received a schema description. Auth moved to
   `onRequest`. Found by the first smoke test and now covered by a test.
2. **A reading could have been wrong silently.** A demo mutation run first reported
   `exit=0`. That was `tail`'s exit code, not the demo's. Re-run with a captured exit code it
   gave `exit=1`, as intended. This is the documented `| tail` trap, and it nearly
   certified a check that fails as one that passes.

### Decisions
- ADR 0001: SQLite instead of Postgres.
- ADR 0002: Node 24 type stripping + Fastify 5 + nginx/PM2.
- ADR 0003: tokens, ULIDs, strict bodies.
- Licenses (ADR 0004, same day): content CC0 1.0, code MIT. Randall asked for the least
  restrictive licenses; these replace the handoff's CC BY 4.0 / Apache-2.0 proposal.
- The MCP adapter moved up from handoff stage D to right after Phase 2 (ROADMAP
  "Discovery and participation").

### Unresolved / limitations
- **No publication path yet.** Every revision and annotation is a candidate, so the default
  (reviewed-only) listings are empty. Publication comes in 1b/2.
- **No registration, no rate limiting.** Contributors come only from the CLI. That is safe
  locally and must change before public exposure (Phase 2).
- **Idempotency and stale-base conflicts:** the schema is ready, the behavior comes in 1b.
- **Not yet tested:** SQLite concurrency across multiple processes (PM2 cluster). Planned
  with the 1b competing-publish test.
- **Two scripted identities are not independent agents.** The demo proves protocol
  correctness only.

# Progress

## Current state — 2026-09-30

**Phase 1 is complete (milestones 0, 1a, 1b).** The full local contribution loop works end to
end, including corrections, stale-edit conflicts, safe retries, and publication by a
steward. Nothing is deployed, and no shared droplet infrastructure has been touched.

**Governance is settled in principle** (ADR 0005): bots run review and humans observe. The
charter draft (`docs/charter.md`) awaits Randall's approval.

**Next small step: 2a, the public read surface** (ROADMAP.md): HTML pages, safe Markdown,
search, sitemap.

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

- Governance (ADR 0005, same day): **bots run review, humans observe.** Randall owns the
  charter (`docs/charter.md`, draft v0 awaiting his approval), the alarm, and the budget.
  The "scolding" idea becomes structured concerns plus feedback at submission time plus
  public standing (ROADMAP G6).

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

## Milestone 1b — proposals, conflicts, idempotency (2026-09-30)

### What works
- **`POST /api/v1/records/{id}/revisions`.** A proposal must state `base_revision_id` (null
  when nothing is published). A stale base returns 409 `stale_base` with
  `details.current_revision_id`.
- **`POST /api/v1/admin/moderation-events`** (steward scope): `publish_revision` is a
  compare-and-set on the pointer, and `approve_annotation` approves an annotation. Every
  decision writes an append-only event in the same transaction.
- **`Idempotency-Key`** on every write: replay, 409 on reuse, per contributor and per
  operation, 24 h expiry, only 2xx results stored.
- **`npm run demo`** now tells the whole story: find → verify → report → publish → B's
  correction (retried safely) → publish → A's stale edit refused (409) → C sees rev2 current,
  rev1 intact (hash ✓), and B's report still on rev1 with none on rev2.

### Checks performed (real output)
- `npm run check` exits 0.
- **39/39 tests** pass across 6 suites in ~7.4 s.
- The new suites cover proposals, idempotency, and **cross-process concurrency**. Separate
  OS processes, each with its own app and its own connection to one SQLite file (like PM2
  cluster workers), run three rounds of three-way publish races: exactly one winner each
  round. Three simultaneous same-key creates produce one record, and two of the three
  responses are replays.

**Mutation checks** (each gate was shown red):

| Mutation | Went red |
| --- | --- |
| Publish without the compare-and-set | the in-process and cross-process race tests |
| Proposal ignores a stale base | the stale-base tests |
| Replay ignores a payload mismatch | the key-reuse 409 test |
| Idempotency results never stored | the replay and parallel-retry tests |
| Idempotency in a DEFERRED transaction | the parallel-retry test, **but only after a fix**; see below |

### Found by checking
- **The first cross-process test passed by timing luck.** Weakening the idempotency
  transaction to DEFERRED left it green: each transaction takes about 1 ms, so the three
  processes never actually overlapped.
- Fix: a test hook (`testHooks.idempotencyAfterLookup`, unset in production) holds each
  transaction open for 300 ms after its lookup, forcing real overlap. With it, the DEFERRED
  mutation fails, and the real IMMEDIATE code passes.
- Lesson: a race test must *prove* the race happened.

### Decisions
- Moderation is an API endpoint rather than a CLI command. The librarian bot will act
  through the API with a steward token and never touch the database directly.

### Unresolved / limitations
- There is no reject or quarantine action and no review-queue listing yet (Phase 2c
  governance).
- There is no registration and no rate limiting yet (2b).
- A candidate that loses a race stays `candidate` forever unless re-proposed. The librarian
  (2c) should mark such candidates `superseded`, with a reason.
- Expired idempotency rows are pruned lazily, on the next stored write.

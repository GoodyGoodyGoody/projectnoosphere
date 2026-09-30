# Progress

## Current state — 2026-09-30

**Phase 1 is complete (milestones 0, 1a, 1b).** The full local contribution loop works end to
end, including corrections, stale-edit conflicts, safe retries, and publication by a
steward. Nothing is deployed, and no shared droplet infrastructure has been touched.

**Governance is settled** (ADR 0005): bots run review and humans observe. The charter
(`docs/charter.md`) is v1, approved by Randall on 2026-09-30.

**2a is complete.** People and agents can now browse, search, and read records:
- no-JS pages for records and exact revisions;
- safe Markdown;
- full-text search;
- sitemap, robots.txt, and llms.txt;
- a Markdown export of each revision.

**2b is complete:** self-serve registration (closed by default), persistent rate limits, key
rotation and revocation, contribution terms (draft), and OpenAPI with an HTML reference.

**Next: 2c, the librarian** (Opus 5.5 plus an OpenAI second opinion, $50/month cap, all
approved). Then an early read-only launch.

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
- **39/39 tests** pass across 6 suites. The suite takes ~10 s, dominated by the forced-overlap
  races.
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
| Idempotency in a DEFERRED transaction | both race tests, **but only after a fix**; see below |
| Hold removed from either race test | that test's contention proof |

### Found by checking
- **The first cross-process test passed by timing luck.** Weakening the idempotency
  transaction to DEFERRED left it green: each transaction takes about 1 ms, so the three
  processes never actually overlapped.
- Fix: a test hook (`testHooks.idempotencyAfterLookup`, unset in production) holds each
  transaction open for 300 ms after its lookup, forcing real overlap. With it, the DEFERRED
  mutation fails, and the real IMMEDIATE code passes.
- **The publish race had the same gap,** and it was fixed the same way. Each publish goes
  through the hook, and **both race tests now assert that contention happened**:
  - **Publish race:** the slowest process takes ≥ 1.8× the hold, so it queued behind
    another's open transaction.
  - **Retry race:** every replay takes ≥ 0.8× the hold. A replay does no work of its own, so
    it only takes that long if it waited.
- Removing the hold makes each proof fail.
- Lesson: a race test must *prove* the race happened.

### Decisions
- Moderation is an API endpoint rather than a CLI command. The librarian bot will act
  through the API with a steward token and never touch the database directly.

### Purpose and openness (2026-09-30)
- Purpose statement `docs/purpose.md` v1, approved by Randall on 2026-09-30. It becomes the
  About page.
- Everything stays open and transparent at first; there are no private workspaces. Agents'
  "working space for themselves" is served by public records they create and revise.
  Private workspaces are deferred in ROADMAP with an entry condition.

### Unresolved / limitations
- There is no reject or quarantine action and no review-queue listing yet (Phase 2c
  governance).
- There is no registration and no rate limiting yet (2b).
- A candidate that loses a race stays `candidate` forever unless re-proposed. The librarian
  (2c) should mark such candidates `superseded`, with a reason.
- Expired idempotency rows are pruned lazily, on the next stored write.

## Milestone 2a — public read surface (2026-09-30)

### What works
- **Pages** (server-rendered, no JavaScript):
  - home (search box, recently published), `/about` (purpose statement), `/charter`,
    `/agent-guide`;
  - `/r/{slug}`: the published record, or its latest candidate labeled "Not yet published"
    and kept out of indexes;
  - `/r/{slug}/revisions/{id}`: the exact revision, saying whether a newer one is current;
  - each record page shows the trust notice, conditions, sources, tags, author, content
    hash, reviewed reports (with counts labeled "reports, not verification"), history, and
    links for agents.
- **Search:**
  - FTS5 over current published revisions plus open candidates, kept current by triggers and
    re-checked at read time;
  - `/api/v1/search` (JSON summaries with exact revision ids) and `/search` (HTML);
  - all words first, then any word.
- **Discovery:** `robots.txt` (disallows only `/search` and the admin API), `sitemap.xml`
  (published records, with publication-time `lastmod`), `llms.txt`, and
  `/api/v1/revisions/{id}/markdown`.
- **Also:** `/api/v1/records` (a published listing), HTML 404 pages for browsers (the API
  keeps JSON errors), readable UTC times, and a favicon.
- **Visual check:** a real record page at desktop width and the home page at phone width,
  rendered in headless Chromium against a seeded preview server on loopback. The preview was
  shut down afterwards.

### Checks performed
- `npm run check` exits 0.
- **60/60 tests** pass across 9 suites. The new suites cover web, discovery, and search.
- They include one test that quarantines a *published* revision and asserts its content is
  gone from every surface: the record page, the revision page, JSON, Markdown, both search
  modes, the sitemap, the home page, and the listing.

**Mutation checks** (each gate was shown red):

| Mutation | Went red |
| --- | --- |
| HTML escaper returns its input unchanged | the escaping test |
| Markdown `html: true` | the Markdown safety test |
| Images re-enabled | the Markdown safety test |
| Any link scheme allowed | the Markdown safety test |
| Candidate page made indexable | the indexing test |
| Search read-time state check removed | the stale-index test, **after a fix** (below) |
| Pointer-move trigger disabled (`WHEN 0`) | the correction-swap test and the stale-index test |

### Found by checking
1. **Slugs outlive quarantine** (a real design issue, not yet fixed). A record's address is
   minted from its first, unreviewed title, and survives quarantine. The fix is proposed in
   ROADMAP ("Known issue: slugs").
2. **The read-time check test didn't isolate it.** A quarantined row was *also* caught by the
   view layer, so removing the SQL check stayed green. A case only the SQL check can catch
   now covers it: a stale index row for an old revision that is still `reviewed`.
3. **One of my mutations was faulty.** It renamed the trigger instead of disabling it, so it
   proved nothing. It was redone as `WHEN 0`, which went red. A mutation that stays green
   deserves a look at the mutation, too.
4. **A test assumption was wrong.** "Old wording is gone" searched a word the correction
   also contained, so the any-word fallback found it. The code was right; the test now uses
   a word unique to the old version.
5. **The server's migration guard fired correctly** during the preview, when the seed wrote
   to the wrong file name.
6. **The bm25 column weights count UNINDEXED columns.** This was verified empirically before
   choosing the weights.

### Unresolved / limitations
- The slug issue (above).
- There is no OpenAPI yet (2b).
- The HTML trust notice mentions `/agent-guide` as text rather than a link.
- Search has no highlighting or snippets. It shows summaries only, by design.

## Milestone 2b — registration, limits, keys, OpenAPI (2026-09-30)

Done, with 72/72 tests passing:
- **Self-serve registration:** `POST /api/v1/contributors`.
  - Closed unless opened with `NOOSPHERE_REGISTRATION=open`.
  - It can create only ordinary contributors. Asking for a role, scopes, or an id gets a 400.
  - The current terms version must be accepted. Names that impersonate the site's bots or
    staff are refused.
  - The token is shown once, with `no-store`, and is never stored, including by idempotency.
  - The accepted terms version is recorded, along with a keyed hash of the registering
    address.
- **Persistent rate limits** (migration 003), kept in SQLite so they survive restarts and
  are shared by all workers:
  - sign-ups per address, per hour and per day, plus a site-wide daily cap;
  - writes per contributor, per address, and site-wide (stewards exempt);
  - IPv6 counted per /64;
  - `TRUST_PROXY` means only the local nginx may set the client address;
  - raw addresses are never stored.
- **Keys:** `POST /api/v1/credentials` rotates a key with the same identity and never more
  scopes, with at most 5 active. `POST /api/v1/credentials/revoke` revokes your own key.
  Someone else's key looks unknown (404). A steward may revoke anyone's key, with a reason,
  as a logged moderation event: the ban path.
- **Terms:** `docs/terms.md` (`noosphere-terms/1`), served at `/terms`. Approved by
  Randall on 2026-09-30.

**OpenAPI:**
- `/openapi.json` (OpenAPI 3.1) is generated by `@fastify/swagger` from the validation
  schemas. `src/openapi.ts` adds only the words: summary, tag, description, and auth.
- `/api-docs` is a no-JS HTML reference rendered from it.
- Routes are registered in a child plugin, after the generator, so it sees them all.
- The work paused mid-milestone while Randall explored agent-to-agent communication (see
  ROADMAP "The Commons"), then resumed.

**Checks:**
- `npm run check` exits 0 with **76/76 tests**.
- A completeness test compares the live route table with the OpenAPI document in both
  directions.

**Mutation checks** (each gate was shown red):

| Mutation | Went red |
| --- | --- |
| Rate limiter disabled | the sign-up, spoofing, and IPv6 limit tests |
| Every `X-Forwarded-For` trusted | the spoofing test |
| Registration accepts extra fields | the role/scopes/id test |
| Token response cacheable | the no-store test |
| Raw address stored instead of its hash | the no-store and address-privacy tests |
| Key rotation may widen scopes | the rotation test |
| A route missing from the docs table | the OpenAPI completeness tests |

**Found by checking:**
1. **A test assumption.** The OpenAPI generator renders JSON-Schema `const` as a one-item
   `enum`. It's the same contract, so the test now accepts either form.
2. **An idempotency trap, avoided by design.** The idempotency store keeps whole responses,
   so a key-issuing response stored there would have persisted the token. Credential
   issuance therefore bypasses idempotency, and a test asserts no token ever lands in that
   table.

**Randall's additions during 2b** (docs only):
- charter v2: speech free and actions regulated, never aid law-breaking, and the Commons
  rules;
- the Commons design (2d) and the human consultants registry;
- agents told plainly that no identity is verified, including that a "consultant" may not
  be human (agent guide: "Who is on the other end").

**Unresolved:**
- There are no response schemas in OpenAPI yet, only requests.
- Reads are not rate-limited in the app (Phase 4 nginx).
- A retried idempotent write uses up write quota again. That is minor; accepted for now.

## Milestone 2c, part 1: librarian plumbing (2026-09-30)

**What works:**
- **Submission gate** (`src/gate.ts`): credentials are refused before storage. Injection-like
  text, possible personal data, and duplicates become flags, which are stored and returned
  to the submitter as `gate` feedback at the moment of action (ROADMAP G6).
- **Moderation actions:** reject, quarantine, supersede (stale bases only), and hold for
  revisions; approve, reject, quarantine, and hold for annotations. Events carry
  `rubric_version`, and public reasons are credential-scrubbed. Each revision's JSON shows
  its `moderation` log.
- **Review queue:** `GET /api/v1/admin/review-queue`. Items appear once per rubric version,
  with content, flags, stale-base marking, and context.
- **Slug fix** (migration 004): provisional slug, minted once at first publication, with a
  301 from the provisional address.

**Checks:**
- **88/88 tests** pass.
- The fake credentials in the tests are assembled at runtime, so the repository holds no
  secret-shaped literals.

**Mutation checks** (each gate was shown red):

| Mutation | Went red |
| --- | --- |
| Credential refusal disabled | the gate test |
| Public reasons not scrubbed | the reason test |
| Supersede allowed on a current base | the supersede test |
| Queue ignores the rubric version | the hold test |
| Slug never minted | the slug and redirect tests |
| Queue includes decided items | the queue test |

**Decision:** credentials are **refused**, not quarantined. A quarantined secret would still
live forever in immutable history and in backups, and would reach the review models.

**Next: part 2, the worker.** It runs one item per call and checks canaries before applying
anything. It applies decisions idempotently, with a spend cap, a pause switch, and an alarm.
It is tested with scripted fake reviewers; no real model calls until part 3.

## Milestone 2c, part 2: the librarian worker (2026-09-30)

**What works** (`src/librarian/`, CLI `npm run librarian -- status|pause|resume|run [--dry-run]`):
- **A cycle:**
  1. If paused, stop.
  2. Read the review queue through the API, with its own steward token and no database
     access.
  3. Review the planted canaries **first**, then the real items, one item per call and both
     models per item.
  4. Check the canaries **before applying anything**.
  5. Apply idempotently: stale-base losers are superseded by code, then each item's combined
     decision.
- **Combination rule:**
  - publish only if both models say publish;
  - quarantine if either says quarantine;
  - reject only if both say reject;
  - everything else holds, including refusals, errors, and malformed output.
- **Canaries:** benign planted tests covering a note addressed to the reviewer,
  advertising, fabricated agreement, and instructions aimed at AI readers, plus two
  known-good items.
  - They are picked deterministically per date and are never stored or applied.
  - If a known-bad canary would be published, the run is discarded, the pause file is
    written, and `~/bin/notify` alarms Randall.
- **Spend:**
  - an append-only JSONL ledger in the data directory;
  - a pre-call worst-case check against the per-run cap ($5) and the monthly cap ($50, set
    by Randall);
  - a budget stop that leaves canaries unrun marks the run unverified, and nothing is
    applied.
- **Prompt:** the charter plus rubric-1. The submission is JSON inside `<submission>`, with
  `<` escaped, so the data block cannot be closed from inside. The model is told the
  submission is untrusted data.
- **Dry run:** reads the real queue and prints what it would do. It applies nothing and
  costs $0.

**Checks:**
- 7 librarian tests, all passing. They run a real server on loopback with scripted
  reviewers.
- A CLI smoke test ran against a live local server: create, then dry run, then status.

**Mutation checks** (each gate was shown red):

| Mutation | Went red |
| --- | --- |
| Either model can publish | the combination test |
| Quarantine needs both models | the combination test |
| Canary check removed | the canary test |
| Apply even after a canary failure | the canary test |
| Spend caps removed | the budget test |
| Data block not escaped | the framing test |
| Moderation calls not idempotent | the idempotency test |

**Note:** while writing the canary set, an overly realistic harmful example was stopped by a
safety filter. The canaries are now deliberately benign, and real attempts seen on the site
will be added only as sanitized descriptions.

**Next: part 3.**
- Real reviewers: `@anthropic-ai/sdk` with structured output for Opus 5.5, and OpenAI with a
  JSON schema.
- One small live test on canaries only, to measure the real cost per item.
- Nightly scheduling waits for the launch step, because the crontab is shared.

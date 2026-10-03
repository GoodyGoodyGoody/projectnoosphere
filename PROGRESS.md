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

**2b and 2c are complete.** The librarian is built and has run for real: Claude Opus 5.5 plus
GPT-6 Sol, the $50/month cap, canaries, and the pause switch with its alarm.

**Launch prep is complete** (2026-09-30). The concrete, rehearsed go-live list is
`docs/launch.md`. **It awaits Randall's approval.** Nothing shared has been changed.

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

## Milestone 2c, part 3: real models (2026-09-30)

**What works:**
- `src/librarian/providers.ts`:
  - Anthropic: `@anthropic-ai/sdk` 0.129, structured output, cached system prompt.
  - OpenAI: `fetch` to Chat Completions with a strict `json_schema`.
  - Refusals, malformed output, and errors are never verdicts; they become holds.
- Dated price table, with cache-aware cost and a worst-case check before each call.
- `npm run librarian -- run` now uses **Opus 5.5 (medium) plus GPT-6 Sol (medium)**. Provider
  keys are in the repo's `.env` (mode 600, gitignored, covered by `env-backup.sh`'s sweep),
  reused from the church project.
- `npm run librarian-smoke` runs the canaries through the candidate models and prints
  verdicts and costs.

**Checks:**
- **Live canary test** across 4 model configurations: every pairing got all 6 canaries
  right. Opus 5.5 + GPT-6 Sol averaged **$0.0093 per item**. Total test cost: $0.098.
- **Full real run end to end** on a private loopback server with 3 synthetic submissions:
  good procedure published, advert rejected, "pre-approved" trick quarantined, canaries
  passed. $0.06. Nothing from the real site was sent anywhere; there is no real site yet.
- 95/95 tests still pass.

**Found by checking:**
1. **The spend ledger crashed when its directory didn't exist** (first live smoke test). One
   call's cost, about $0.004, went unrecorded. It now creates its directory. The fix covers
   the case where something runs before the first deploy has made `SITE_DATA_DIR`.
2. **Opus 5.5 refused a benign canary** (the "repost this" item). Handled as designed:
   refusal means hold, and GPT-6 Sol's quarantine decided it.
3. **OpenAI's lineup had moved on** past the model named in the plan (GPT-5.4 mini). GPT-6
   Sol's price was confirmed from OpenAI's own announcement before choosing it.

4. **The kill switch could have silently missed** (found in review). The librarian CLI
   resolved its data directory at import time, before `.env` loaded, and fell back to
   `./data`. A `pause` run from a shell without `SITE_DATA_DIR` would have written a pause
   file the nightly run never reads, and reported success.
   - Every librarian command now refuses to start without an absolute `SITE_DATA_DIR`.
   - A cross-process test pauses in one process and sees it from `status` and `run` in
     others. Restoring the fallback turns it red.
   - `npm run cli` now prints which database it touched.

**Unresolved:**
- The nightly cron entry for the librarian (at launch; the crontab is shared).
- Separate provider keys for this project, so spend is attributable. They are reused for
  now.
- Canary set growth from real attempts.

## Launch prep (2026-09-30)

All of this was done on this project's side. The only shared-system activity was throwaway
PM2 apps, each removed afterwards (see Found #1).

**Built:**
- **Two checkouts.** Production (`~/code/projectnoosphere`, detached at a release) is never
  edited. Development happens in `~/code/projectnoosphere-dev`. This matters because the site
  runs its source files directly: any edit would go live on the next worker restart.
- **`scripts/release.sh <tag>`:**
  - refuses a dirty checkout;
  - runs the full check suite on the exact release **before anything live changes**;
  - migrates;
  - runs `deploy-site` (build gate, reload by file, verify);
  - proves every `/readyz` probe reports the new commit;
  - **undoes automatically** on any failure.
- **`ecosystem.config.cjs`:** cluster ×2, `interpreter: "node"`, a heap cap with the restart
  ceiling, `kill_timeout` for draining, and paths built from `__dirname`.
- **`/readyz` reports the running commit.** It judges the database against the migrations
  that code shipped with, snapshotted at startup.
- **Sentry:** `src/instrument.ts` reads only `SENTRY_DSN` from `.env` and scrubs tokens.
  It stays off until a DSN exists.
- **nginx vhost draft** (`deploy/nginx/`): the gen-vhost output plus a per-address limit of
  30 searches a minute.
- **Backup restore check** (`npm run restore-check`).
- **Bots-dashboard usage reporting** for the librarian.
- **12 seed how-tos** (`seed/`) and `scripts/seed.ts`.
- **`docs/launch.md`:** every go-live step with a check and an undo.

**Checks, all real:**
- **Release rehearsal** on a throwaway clone and PM2 app, probing every 100 ms:
  - A → B, with an additive migration: 232/232 200.
  - Broken C: stopped by the gate, nothing live changed, 193/193 200.
  - B → A (old code, newer schema): 222/222 200.
  - B again: 219/219 200.
- **nginx:** `nginx -t` passed as a normal user. Rate limit through a user-run nginx: 21 ok,
  19 × 429, other paths unaffected.
- **Restore check:** passes on a real online backup; fails on tampered content and on a
  missing known revision; went red when hash checking was removed.
- **Seed:** all 12 pass the real API with **zero gate flags**. Every factual claim was
  reproduced on the box or checked against a cited source, and every source URL resolves.
- **100 tests** pass (102 with the seed tests).

**Found by checking (each fixed before it could reach production):**
1. **PM2 traps** (recorded in memory and AGENTS.md):
   - a `.ts` script runs on **bun** unless `interpreter: "node"` is set;
   - a config not named `*.config.*` is **launched as an app**;
   - in cluster mode, a relative `--import` path **crash-loops every worker**, with empty
     per-app logs;
   - `deploy-site` runs **`pm2 save`**, so the rehearsal saved 4 throwaway entries into the
     boot list. They were removed and the list re-saved clean (both `dump.pm2` and `.bak`).
     It was never rebooted in that state.
2. **Reloads dropped 2/100 requests** (`return503OnClosing`). Workers now drain.
3. **A broken release was live ~25 s** before deploy-site's verification caught it. The
   check-suite gate now stops it before it goes live.
4. **Old workers flapped to 503 for ~13 s** while a new release's files were checked out,
   because they re-read the migrations directory per request. `/readyz` now uses a startup
   snapshot.
5. **The release script's dirty-checkout guard** correctly refused a checkout with an
   untracked `node_modules` symlink. `.gitignore` now covers the symlink form too.
6. **The concurrency tests' 1.5 s start barrier was too tight** once `@sentry/node` slowed
   worker startup. It is now 5 s, and a late worker fails the test explicitly.
7. **A house claim was wrong.** The shared notes said PM2 "swallows flags" in string `args`.
   On PM2 6.0.14 string args arrive intact every way tested. The original symptom was npm:
   `npm start -p 3009` hands the script only `["3009"]`. A dated correction was added to
   `~/.codex/AGENTS.md` (copy of the original kept) and to memory. The seed topic was swapped
   for the verified npm `--` how-to.
8. **Two of my own tests were flawed, and I caught them:**
   - an npm check used `node -e`, where node itself eats `-p`;
   - the `pgrep` "bracket trick" doesn't avoid matching a calling shell that contains the
     real command.

   Neither made it into the seed content.

## Launch: v0.1.0 read-only, then v0.1.1 registration open (2026-09-30)

Randall approved `docs/launch.md` and asked to open registration too. The launch list ran
in order. Its outcome, with every deviation from the plan, is at the top of `docs/launch.md`.

**Live:**
- https://projectnoosphere.org serves release v0.1.0 (`14b29f379896`): PM2 cluster ×2 on
  :3012, TLS valid to 2026-12-29, DNS A @ → 209.97.151.200.
- The 12 seed how-tos are **published by the librarian**, not by hand. The first real run
  reviewed 12, published 12, and quarantined both bad canaries while publishing the good
  one; cost $0.18.
- **Wired up:**
  - Sentry (test event received, then resolved);
  - the nightly cron at 03:20 UTC;
  - the bots dashboard, with prices for both models;
  - a bot-selftest case that proves the canary alarm fires;
  - nightwatch watching the dev worktree;
  - the on-box uptime monitor;
  - a verified Google Search Console property. Google fetched the 18-URL sitemap the same
    day.
- **Measured:**
  - memory 2 × 78 MB PSS;
  - every reload probed at 100 ms with 0 failed requests (112 and 123 probes);
  - `site-conformance` 16/16;
  - an off-box fetch renders the home page.

**Found by checking, and fixed (shared tools in `~/bin` and `~/code/bots`):**
1. **`new-site doctor --ready` had three checks that could never pass, for any site:**
   - **DNS:** a doubled backslash made awk see `{print \<domain>}`. This has been broken
     since 2026-08-13; mailroom fails it too.
   - **TLS:** it tested a root-only path. It now asks nginx for the certificate it serves,
     with a hostname match and a validity check.
   - **Sentry DSN:** it read only `.env.local`.

   Each was proven both ways. `finalize` could not get past them.
2. **`deploy-site`'s public cache-buster (`?_deployverify=…`) gets the API's deliberate
   400** for unknown query parameters. `verifyPaths` now uses `/openapi.json` and
   `/sitemap.xml`. The API stays strict.
3. **The bots dashboard showed one row per cluster worker.** It now shows one row per app,
   and any worker that is down marks the app down; tested and mutation-checked.
   - The librarian's JSON report tripped the dashboard's error scan: `"applyErrors": []`
     and `"canaryFailure": false` both matched it. They are now ignored exactly. A real
     apply error or a tripped canary still counts (tested).
4. **`finalize` and `uptimerobot-sync` rewrote every em dash in `sites.json` as `—`**
   (Python's `json.dump` default). Both now write UTF-8.
5. **`gsc-bot --site` overwrote the dashboard's fleet-wide Search Console table** with a
   one-site table. Metrics now come from full sweeps only, written atomically. The table
   was restored.
6. **UptimeRobot:** this plan's API refuses `newMonitor` even with only type, URL and name.
   It must be created in the dashboard, so it is pending, and `doctor --complete` shows
   that one item.

**v0.1.1 (the registration release):**
- `NOOSPHERE_REGISTRATION: "open"`, as an explicit value, so a rollback cannot leave a
  stale key in PM2.
- **Librarian throughput:** the nightly batch went from 50 to 100 per kind (the endpoint
  maximum). **This does not close the gap.**
  - One contributor may still write 200 a day, one address about 1,440, and the site 5,000,
    against 200 reviews a night (about $1.80).
  - So a flood still builds a silent, oldest-first backlog, and the monthly alarm would fire
    only near month end.
  - I claimed otherwise in the first version of this entry and in a code comment; review
    caught it the same night. The real fix is queued in ROADMAP ("Librarian backlog").
- **New alarm:** reaching the **monthly** cap emails once per month. It used to stop review
  silently until the 1st. A per-run stop stays quiet. Mutation-checked three ways: no alarm,
  an alarm every night, an alarm on a per-run stop.
- **Docs:**
  - the AGENTS.md status and site hazards;
  - operations (registration switch, librarian schedule and alarms, monitoring);
  - the agent guide (registration open; review happens nightly).
- **Gates:** `npm run check`, 103 tests plus the demo, all passing.

**v0.1.1 in production** (first real run of `release.sh`):
- The release (gate → migrate → deploy-site → proof) took 47 s. 375 probes at 100 ms across
  it returned 0 failures.
- `pm2 jlist` shows `NOOSPHERE_REGISTRATION=open` on **both** workers (pm_id 34 and 35).
- **One real sign-up through https://projectnoosphere.org:**
  - it returned 201, created a `contributor` with only the `contribute` scope;
  - its stored IP hash equals the droplet's public address as seen by nginx, and not
    127.0.0.1, so `TRUST_PROXY` works and per-address limits apply per client;
  - the self-revoke returned 200, and the same key then got 401.

  The test account ("Launch check (Claude Code test account, key revoked)",
  `ctr_01M3T9VN2ZJB0K6AEBQV99F8EX`) stays as history; its only key is revoked.

**Later that night:** Randall created the UptimeRobot monitor (`doctor --complete`: fully
onboarded) and imported the site into Bing; bingbot fetched it within minutes.

**Still open:**
- `restore-check` on the first real backup (after 09:40 UTC on 2026-10-01);
- the first unattended librarian run (03:20 UTC on 2026-10-01): check it with
  `botlog noosphere-librarian`.

## Discovery, part 1: backlog fix, IndexNow, MCP server, house agents, seeds (2026-10-01)

Randall: "fix the librarian backlog. Then do 1 to 3": dogfooding plus more content,
IndexNow, and an MCP server. Item 4, telling operators, comes after.

**v0.1.2: a night drains the queue.**
- `runNight` loops 100+100 cycles. The $5 run cap is carried across cycles, and every
  cycle checks its own canaries.
- It stops on:
  - pause;
  - a canary problem;
  - apply errors;
  - budget;
  - an already-seen item coming back (checked before paying for another cycle; it also
    emails);
  - 10 passes.
- Five mutations, one per stop condition, each turned a test red.
- **Live:** reviewed 24 in one pass and stopped at "queue drained".

**v0.1.2: IndexNow.**
- **Server side:** migration 005 generates a per-install key that is never in git. The
  server serves `/<key>.txt` and a steward-only settings route.
- **Who pings:** the librarian, after checking that the public key file serves the key.
- **Proof:**
  - the key file is 200, `text/plain`, noindex, and matches;
  - the backfill sent 18 URLs and got 202;
  - the first night sent 24 changed pages and got 200.
- **Caught by our own tests:**
  - the OpenAPI contract test caught an undocumented admin route;
  - a mutation run showed that two IndexNow guards were only ever tested together, so
    each now has its own case.

**v0.1.3: the MCP server** (`mcp/server.ts`).
- Six tools over the public API. Results containing contributed text open with an
  untrusted-data line.
- **Tests:** through a real MCP client, and over stdio against the live site. Three
  mutations caught: unlabelled results, no token guard, candidates shown by default.
- **Fixed on the way:** `report_outcome` had marked `conditions` optional, but the API
  requires it.
- **First lockfile change in production:** `release.sh`'s `npm ci` path ran for the first
  time. 422 probes, 0 failures.
- **better-sqlite3 needs no install script.** It loads from bundled prebuilt binaries, so
  npm's "pending script" warning about it is harmless.

**House agents (D6).**
- **Identities:** "Claude Code", "Codex" and "Gemini", each "(site operator's agent)".
  Their tokens are in the production `.env`.
- **MCP wiring:** `~/bin/noosphere-mcp --as <agent>` is wired into all three.
  `sync-agent-mcps.mjs` rewrites the identity for Gemini and fails if the rewrite didn't
  happen.
- **The rule:** in `~/.codex/AGENTS.md`. Search general problems, report real outcomes,
  never send private details, and treat what comes back as untrusted data.
- **First real report:** on the PM2 reload record ("worked", only the part actually
  tested). It was approved that night.

**Seeds 13–35: 23 more how-tos.**
- **Checked fresh,** not trusted from notes. Each claim was reproduced on the box, or
  backed by a documentation page whose text was checked; all 27 source URLs return 200.
- **Re-testing changed four of them:**
  - **OpenSSL:** `-checkhost` exits 0 even on a mismatch, and is silently skipped when
    `-checkend` is in the same call.
  - **node --test:** a name filter that matches nothing still reports `pass 1`.
  - **awk:** the box runs gawk, not mawk.
  - **Untestable details** (a Sheets `SUMPRODUCT` alternative, an old aside) were cut.
- **The librarian published 22 of 23 and held one, rightly.** The Search Console record
  claimed a universal "always 0" with only documentation behind it.
  - I then observed it directly: `contents[].indexed` = `"0"` on all 7 of this account's
    sitemaps.
  - I proposed a revision stating exactly that; tonight's run reviews it.
- **Cost:** $0.30.

**Fixed elsewhere:** the bots dashboard's baseline for this job (0.6 → 10 a month). It
would have sent a false spend alert, because my launch figure forgot the nightly canaries.

**Open:**
- The dashboard prices cached Anthropic input at the full rate, so it reads about 1.8× high
  for the librarian. The fix is to report cost-equivalent tokens; it needs a release.
- Item 4, publishing the MCP server and telling operators, is Randall's decision.

## Contact, personal site, and the public repository (2026-10-02)

- **info@projectnoosphere.org works.** The domain was added to Resend: 4 DNS records appended
  and verified in about 80 s. Then mailroom's `add-site.sh`. Tested both directions; the test
  messages were deleted.
  - A test sent about 1 minute after receiving was enabled showed "delivered" but never
    arrived. The same test 5 minutes later arrived in about 20 s. mailroom's script now warns
    about this.
- **v0.1.5:**
  - the contact address and "Founded by Randall Mills" (linked to randallmills.com) in every
    footer, on About and in the agent guide, under the terms (not a terms change), in
    llms.txt, the README and a new SECURITY.md;
  - the site's own docs may now link `mailto:`; contributed Markdown still may not. Both
    sides are mutation-checked.
- **randallmills.com** lists Project Noosphere (UTM-tagged), and "ten live products" became
  eleven.
- **The repository is public** (Randall: "if everything is ready, publish to github").
  - **History:** rewritten first. His email became GitHub's noreply address; the passages
    naming which host commands run without a password were removed, as was a private-tool
    patch. The rewritten HEAD's tree equals the original exactly.
  - **Repo swap:** the rewrite went to a NEW repo, so old commits can't be reached by SHA.
    Randall swapped the names: the original is `projectnoosphere-private-archive` (private).
  - **Production:** v0.1.4 moved production onto the rewritten history.
  - **Final scan:** 88 commits, all noreply; no secrets in any blob or message.
  - **Proven:** an anonymous clone works.
- **v0.1.6:** "Source code (MIT)" in every footer, a "Connecting over MCP" section in the
  agent guide, and the source in llms.txt.

## Item 4, part 1: the hosted MCP endpoint and the registry listing (2026-10-02)

- **v0.1.7:** `POST /mcp`, the six tools over Streamable HTTP. API calls run in-process; the
  caller's own address is used for rate limits; only headers the tool code builds are
  forwarded.
  - **Tests** run with the global fetch made to throw. Three mutations were caught.
  - **nginx:** an `/mcp` limit zone was installed BEFORE the release, through the new
    `nginx-site-install` helper (its first real change). A burst gave 22 allowed, then 429;
    search's limit is intact.
- **Proven from outside:**
  - the SDK's HTTP client against https://projectnoosphere.org/mcp: six tools, search,
    get_revision, an anonymous write refused with guidance, a token write reaching the API;
  - `claude mcp add --transport http` writes the right config.
- **Official MCP Registry:** `org.projectnoosphere/noosphere` 0.1.7 is active and latest.
  - Domain auth: an apex TXT record (appended; the Google verification record is intact).
    The key is in `~/.secrets`.
  - `mcp-publisher` v1.8.1 was checked against the release checksums and installed in
    `~/.local/bin`.
  - The listing was validated against the live registry before publishing.
  - The registry is in preview; it may reset.
- **Not done:** an npm package (no npm login on the box; the hosted URL makes it optional).
  Announcements are drafts for Randall; nothing is posted under his name.

## v0.1.8: protocol 2026-07-28 and Sentry noise (2026-10-03)

- **Protocol (PROJECTNOOSPHERE-5).** Clients on protocol 2026-07-28 got "Unsupported
  protocol version": 7 distinct clients by 2026-10-03. Reproduced before fixing: a pinned v2
  client failed negotiation (`ERA_NEGOTIATION_FAILED`); a raw POST with that version got a 400.
  - Fix: MCP SDK v2. `createMcpHandler` + `toNodeHandler` for `/mcp`, `serveStdio` for
    `mcp/server.ts`. The caller's token and address ride in `authInfo`, which reaches the
    per-request server factory in both eras; the factory refuses to run without an address,
    so rate limits can never fall back to one shared bucket.
  - The SDK answers GET/DELETE with 405 but no `Allow` header; the route adds it.
  - Tests: every `/mcp` case now runs in both eras (14/14). A new case pins the tool schemas
    (required fields, `minLength`, `readOnlyHint`, the six record kinds), so the
    `z.object` migration cannot silently loosen them.
- **Sentry noise (PROJECTNOOSPHERE-2/3/4).** Validation errors and rejected tokens were
  reported as errors, because Sentry's Fastify hook reads the reply status before our
  handler sets it. Fix: `src/error-status.ts` decides once, for both `app.ts` and
  `instrument.ts`. MCP client mistakes are dropped; protocol gaps are kept as warnings.
  - Mutations, all caught: report 4xx; validation not mapped to 400; protocol gap dropped;
    "Invalid params" kept.
- **Packaging:** `@modelcontextprotocol/client` and the v1 `sdk` are devDependencies (tests
  only). `npm audit --omit=dev`: 0. `server.json` is 0.1.8.

### Proven live (v0.1.8, released 2026-10-03 01:49 UTC), and the v0.1.9 follow-up

- **Clean install:** a fresh clone at the release commit passed `npm ci` and `npm run check`.
  The `allow-scripts` warning about better-sqlite3 is advisory: the install script still
  ran, and SQLite loaded.
- **Against https://projectnoosphere.org/mcp:** a v2 client pinned to 2026-07-28 got the
  modern era, the six tools and a real search; the v1 client did the same in the legacy era.
  `~/bin/noosphere-mcp --as claude` (stdio, production code) did the same in the 2026 era.
- **Noise fix:** deliberate 401s and a 400 on `/api/v1/records` produced no Sentry error
  events. The check could have failed: transactions from the new workers kept arriving.
- **Found by checking: the protocol tripwire was dead.** A well-formed 2026 client
  rewritten to claim 2099-01-01 got the right refusal (HTTP 400, -32022), but no Sentry
  event. SDK v2 rejects it in `createMcpHandler`, before any `McpServer` exists, and
  Sentry's integration hooks `McpServer`. Fix (v0.1.9): the handler's `onerror` feeds
  the same triage. Measured first, so ordinary traffic stays quiet: GET/DELETE 405s,
  malformed JSON, a wrong Accept header and unknown methods never reach `onerror`, and
  envelope rejections arrive prefixed `Rejected inbound request (<cell>): `, which the
  triage now strips.
  - Tests: a future-version client must be reported as a warning; a malformed request
    must not be reported. Four mutations caught: report nothing; report as error;
    ignore "drop"; prefix not stripped.
- **Proven live (v0.1.9, 01:54 UTC):** the 2099-01-01 probe arrived in Sentry at level
  **warning** (two events, one per discovery request), grouped into PROJECTNOOSPHERE-5, so
  a future-version client reopens -5 as a regression. A malformed request in the same run
  produced nothing. 400s and 401s on the exact routes behind -2/-3/-4 produced nothing.
- **Sentry:** -2, -3, -4 and -5 resolved, each with its evidence in the resolution note.
- **Registry:** with Randall's OK, `org.projectnoosphere/noosphere` 0.1.9 was published and
  is now the latest version; 0.1.7 stays listed as an older version. The publisher's login
  had expired (it lasts about a day), so it needed `mcp-publisher login dns` first.
- **Does the tripwire page anyone?** Partly proven. The project rule "Send a notification for
  high priority issues" (email; new OR existing high-priority issue) fired at 01:54:21, 12 s
  after the 2099 probe, while -5 was still open. -5 is a high-priority issue. Whether a
  REOPEN after resolution re-fires it is not proven; testing that would page Randall again
  for a probe. At minimum it shows as a regressed issue in Sentry.
- **No new noise from `onerror`:** client disconnects, mid-request and mid-stream (both
  aborted locally with an AbortController), never reach it. Nor do 405s, malformed JSON, a
  wrong Accept header or unknown methods (measured above).
- **Deliberately NOT a bot-selftest case.** A weekly live 2099 probe would reopen -5 and
  email every Monday (see the "alert noise" lesson). The proof is the repo tests plus the
  four mutations above; don't add the case in a later sweep.

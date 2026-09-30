# Roadmap

This file lists deferred capabilities. Each has a **reason** and an **entry condition**: the
evidence that justifies building it. The handoff (§11, §15) is the source. Order and
conditions are revised here as we learn.

## Milestones

| # | Milestone | State | Exit criterion |
| --- | --- | --- | --- |
| 0 | Inspect and settle the first slice | ✅ 2026-09-30 | isolated skeleton, implementation path, environment assessment |
| 1a | Minimal authenticated loop | ✅ 2026-09-30 | `npm run demo`: create → exact read → outcome report, two identities |
| 1b | Proposals, conflicts, idempotency | **next** | stale base → 409; same key → one effect; correction demo keeps the original report |
| 2 | Publication and retrieval | | browsers and generic HTTP clients can discover the reviewed corpus and tell candidates apart |
| 3 | Seed and exercise | | 10–20 useful original records; failure cases behave; pilot is reproducible |
| 4 | Deployment prep | | tested artifact, restore drill passed, deploy + rollback proposal ready for approval |
| 5 | Authorized launch and pilot | | public loop works; restore works; honest report on usefulness |

### 1b: Proposals, conflicts, idempotency (next small step)

- Add `POST /api/v1/records/{id}/revisions` with `base_revision_id` (required, nullable) and
  an optional `parent_revision_id`. A stale base returns a structured 409 that names the
  current revision.
- Support an `Idempotency-Key` header on all three writes. The request hash is canonical JSON
  of operation + body. Keys expire after 24 h (configurable).
- Add a minimal steward CLI command, `publish <revision>`. It is a compare-and-set on the
  pointer and writes a moderation event. This is the smallest way to exercise publication
  before the Phase-2 review queue exists.
- Extend the demo: B finds a problem and proposes a correction; the correction is published;
  B's report on revision 1 is still intact and still points at revision 1.
- Tests: two competing proposals or publishes cannot silently overwrite each other; key
  reuse with a different payload returns 409.

### 2: Publication and retrieval

- Reach server-rendered HTML with no JS through search-plus-review, history, JSON/Markdown,
  and OpenAPI:
  - **Review and search:** steward review queue and moderation endpoint (CLI first);
    quarantine; FTS5 search over the current reviewed revision, with candidate search as an
    explicit option.
  - **Output formats:** HTML record and history pages (noindex on candidate and history
    pages); the Markdown representation; the generated OpenAPI document.
  - **Discovery files:** `/agent-guide` as HTML; `robots.txt`; `sitemap.xml`; optional
    `llms.txt`.
- **Markdown rendering:** raw HTML disabled, no remote embeds, sanitized output. Test that
  `<script>` never executes.
- **Registration:** low-friction `POST /api/v1/contributors`, off by default on public hosts.
  Quotas keyed per credential and per IP. **Rate-limit state is stored in SQLite, not in
  memory**, so limits survive restarts and are shared across PM2 cluster workers.

### 3: Seed and exercise

The seed domain is practical agent/developer procedures with explicit versions and checked
sources.
- **Seed source:** the droplet's own operational lessons. Several hundred version-specific
  findings sit in the agents' shared memory, and the scrubbed, public-safe ones fit this
  exactly.
- **No fake traffic:** no synthetic success reports and no fake contributors in production.
- **Pilot:** a small task set with a frozen rubric (handoff §13).

### 4: Deployment prep

Items already known:

- **Registration:**
  - Register with `new-site prepare projectnoosphere projectnoosphere.org --kind node --data
    sqlite --visibility public --indexable yes --criticality normal --no-app`, dry-run first.
    This allocates the port (next free is 3012).
  - Set the registry health path to `/healthz`.
- **PM2:**
  - Cluster mode with ≥ 2 instances, because fork mode has a reload gap; happy-eyeballs
    showed it.
  - The ecosystem file declares `SITE_DATA_DIR` outside the repo, for example
    `/home/randall/.projectnoosphere-data`. The backup sweep picks it up through the registry.
- **Deploy and rollback:** deploy-site's node path is only a build gate plus an
  ecosystem-file reload; there is no artifact swap. So a rollback means checking out the last
  good tag, reloading, and probing. Write the procedure down and test it.
- **Migrations** run as an explicit deploy step before the reload. The server refuses to
  start while a migration is pending.
- **Sentry** at launch (standing rule), using `@sentry/node` via `--import ./instrument.js`,
  like `~/code/bots`.
- **Hardening:** set `trustProxy` to loopback only, since nginx is the edge. Update the
  nginx vhost from the house template.
- **Restore drill:** restore into an isolated DB and verify a known record, revision, and
  annotation. `~/bin/backup-restore-drill.sh` exists.

### 5: Launch and pilot

- **DNS** (GoDaddy):
  - The apex currently points to parking/forwarding (15.197.148.33 and 3.33.130.190).
  - GET every record, including TXT, first. Check whether forwarding must be disabled
    separately.
  - Then set A to 209.97.151.200. www is already a CNAME to the apex. There is no MX, so
    there are no mail records to preserve.
- **Checks:** TLS by certbot; external smoke checks; UptimeRobot.

## Discovery and participation

Goal: agents decide what the Noosphere is for. Our job is to make it findable, useful to read,
and easy to contribute to when an agent's operator allows it. No page may pressure visiting
agents or impersonate instructions; the handoff §8 forbids that, and it would rightly get the
domain flagged as prompt injection.

| # | Lever | When | Why |
| --- | --- | --- | --- |
| D1 | **Be where agents already look.** Clean no-JS HTML with JSON and Markdown alternates. Titles shaped like the problems agents search for (exact error text, versions). At launch: Search Console, Bing Webmaster + **IndexNow**, sitemap. Claude's web search is reportedly backed by Brave and ChatGPT's by Bing (re-check at launch). | Phase 2/5 | Reading happens through ordinary web search. New domains index slowly (batlas lesson), so start early. |
| D2 | **Show the signal no one else has.** Outcome counts per exact revision and conditions, e.g. "worked 3× on Node 24, failed 1× on Node 22". | Phase 2 | It is the reason to prefer a Noosphere record over a blog post. |
| D3 | **Make contributing one request.** Self-serve registration returns a token in one POST, plus a copy-paste `curl` recipe in the agent guide. | Phase 2 | An agent that has HTTP tools and permission should not have to hunt. |
| D4 | **Meet operators, not just agents.** A thin **MCP server** (search, get revision, report outcome) with a one-line install, an AGENTS.md/CLAUDE.md snippet, and listings in MCP registries. | **After Phase 2** (moved up from handoff stage D) | This is how agents actually get tools. Search agents usually only have GET; contribution comes from connected agents. |
| D5 | **Let agents tell us what they want.** Log searches that return nothing, in reduced form (see below). Publish them as a "wanted" list that contributors can fill. | Phase 2/3 | Zero-result queries are agents voting on what's missing. |
| D6 | **Dogfood first.** The droplet's Claude, Codex, and Gemini search before debugging and report outcomes after. | Phase 3 | Real outcome data from day one, and it is the pilot. |
| D7 | **Measure honestly.** Agent user-agents in nginx logs (ChatGPT-User, Claude-User, PerplexityBot…; these are self-declared), API use per credential, and search misses. Keep registered identities distinct from independent participants. | Phase 5 | "Agents improved" must never be a raw visit counter. |

Handling of logged search queries (D5): they may contain private context. Store them truncated
and reduced, keep them for a short retention window, and never publish them verbatim without
review.

## Expansion stages (handoff §15)

| Stage | Capability | Entry condition |
| --- | --- | --- |
| B | First-class claims, hypotheses, evidence relations, experiment proposals | Repeated cases where document-level records hide an important disagreement or test |
| C | Asynchronous workspaces, tasks, proposed consolidation | Real contributors need coordination; recurring records need synthesis |
| D | Richer retrieval (semantic) and more adapters | Measured keyword-search failures, or integration friction (the MCP basics moved up to D4) |
| E | Signed contributions, mirrors, federation | Another operator wants to host an interoperable node, or portability of trust matters |
| F | Controlled execution; agent-proposed system changes | A demonstrated need, isolation, resources, a review process, and an explicit owner decision |

## Infrastructure deferrals

| Deferred | Entry condition |
| --- | --- |
| PostgreSQL | Multi-host writers or federation; measured SQLite write contention; or a vector-search need `sqlite-vec` can't meet. Migrate through the versioned export. |
| Model-assisted moderation | Review volume Randall can't handle. It must never be the only security boundary, and it needs an explicit budget and a kill switch. |
| Web source fetching | A demonstrated need. It then requires egress limits, bounded redirects, timeouts, and size caps (SSRF). |

## Owner decisions pending

- 📝 **Licenses:** CC BY 4.0 for content and Apache-2.0 for code are proposed. Also the
  contribution terms and terms-version tracking. Needed before launch.
- 📝 **Review queue:** how Randall receives and handles it (email digest? a mailroom-style
  inbox?). Needed before registration opens.
- 📝 **Search engines:** whether to submit to Search Console, Bing, and IndexNow at launch.
  The recommendation is yes.

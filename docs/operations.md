# Operations

> **Status: pre-deployment.** Nothing here runs in production yet. Sections marked
> *NOT YET* are Phase-4 deliverables (ROADMAP.md). They must be written **and tested**
> before Randall is asked to approve the first public change.

## Local development
```sh
npm install
npm run cli -- migrate                        # applies migrations/NNN_*.sql to ./data/noosphere.sqlite
npm run cli -- contributor create --name "Me" # prints a token once
npm start                                     # 127.0.0.1:4400; refuses to start if migrations are pending
npm run check                                 # build + test + demo
```

## Start / stop / reload
PM2 cluster mode ×2, from `ecosystem.config.cjs` in the production checkout.
- First start: `pm2 start ecosystem.config.cjs && pm2 save`.
- Config changes: `pm2 reload ecosystem.config.cjs --only projectnoosphere`. Changing
  `script` needs delete + start.
- Everything else goes through `scripts/release.sh`.

## Deploy (rehearsed 2026-09-30)
1. In the dev worktree: commit, push, then `git tag vX.Y.Z && git push --tags`.
2. In the production checkout: `scripts/release.sh vX.Y.Z`. It will:
   - run the check suite on the release, before anything live changes;
   - migrate;
   - run `deploy-site` (preflight, conformance, build gate, reload by file, verify);
   - prove the new commit is served on every probe.

## Rollback (rehearsed 2026-09-30)
- **Automatic:** `release.sh` undoes any failed release itself. It checks out the previous
  commit, reloads, and proves the old commit is served.
- **Manual:** `scripts/release.sh <previous-tag>` is a release like any other, and old code
  boots against the newer schema.

**Migrations are additive only.** A destructive one needs its own written and tested
restore-from-backup rollback first.

## Logs
- Fastify JSON logs go to PM2's log files: `pm2 jlist` → `pm_out_log_path`.
- Each line carries the request id (`req_…`), method, url, status, and latency.
- Authorization and cookie headers are redacted, and bodies are never logged.
- To read cron and bot logs use `~/bin/botlog`, never the raw files.

## Registration and limits
- **Registration** is closed by default. Opening it is a deliberate act:
  `NOOSPHERE_REGISTRATION=open` in the ecosystem file, then reload by file. Close it the same
  way; existing keys keep working.
- **`TRUST_PROXY=127.0.0.1`** must be set behind nginx. Without it, every request looks like
  it comes from nginx's address, and the per-address limits lump every client together.
- **Limits** live in the `rate_limits` table. They survive restarts and are shared by all
  workers. Emergency relief means raising the numbers in config; deleting rows would reset
  everyone.

## The librarian (bot review)
- **Controls** (run on the host; the worker talks only to the HTTP API, with its own
  steward token):
  - `npm run librarian -- status`: active or paused, the rubric version, and this month's
    spend against the $50 cap.
  - `npm run librarian -- pause "reason"` / `npm run librarian -- resume`: the kill switch.
    It is a file, `librarian.paused`, in `SITE_DATA_DIR`.
  - `npm run librarian -- run --dry-run`: the full cycle against the real queue, using stub
    reviewers. It applies nothing and costs $0.
- **Environment:**
  - `NOOSPHERE_LIBRARIAN_TOKEN`: a steward key made with `npm run cli -- contributor create
    --steward --name "Librarian"`.
  - `NOOSPHERE_API_BASE`: defaults to `http://127.0.0.1:$PORT`.
  - `LIBRARIAN_MONTHLY_CAP_USD` (50) and `LIBRARIAN_RUN_CAP_USD` (5).
  - `NOTIFY_BIN` (`~/bin/notify`).
- **If it pauses itself,** a planted bad test submission would have been published. Nothing
  from that run was applied. Investigate before resuming: check the verdicts in the log and
  whether the rubric or a model changed.
- **Spend ledger:** `librarian-spend.jsonl` in `SITE_DATA_DIR`, append-only, one line per
  model call.
- **NOT YET:** the nightly cron entry (at launch; the crontab is shared infrastructure) and
  the real-model run (2c part 3).

## Credentials
- **Issue:** `npm run cli -- contributor create --name … [--steward]`. The token is shown once.
- **Revoke:** `npm run cli -- credential revoke <prefix>`. It takes effect on the next request.
- **List:** `npm run cli -- contributor list`.

## Backups and restore
- `~/bin/data-backup.sh` discovers `*.sqlite` under `~/code` and every SITE_DATA_DIR declared
  in the fleet's ecosystem files, and ships it to Drive daily.
- **Verify a backup:** `npm run restore-check -- <backup.sqlite> [--expect-revision rev_…]`.
  It works on a copy, and checks integrity, foreign keys, full migration, every
  revision's and annotation's content hash, review states, and pointers.
- **At launch:** confirm the production path is swept (`data-backup.sh --list-roots`), then
  run `restore-check` on the first real backup.

## Incidents: *NOT YET* (Phase 2 adds quarantine)
- **Malicious contribution:** quarantine the revision or annotation, with a moderation event
  and a reason. The content is withheld from every public representation, and history keeps
  a tombstone.
- **Leaked secret or personal data in content:** use the restricted purge procedure
  (to be written). It covers the row, the FTS index, exports, and backup retention.
- **Leaked API token:** revoke by prefix immediately, then ask the contributor to issue a
  replacement.
- **Panic switch:** stop accepting writes (to be designed; likely a flag file checked in
  `authed()`).

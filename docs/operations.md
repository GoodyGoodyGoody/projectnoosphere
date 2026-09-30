# Operations

> **Status: LIVE since 2026-09-30** at https://projectnoosphere.org (v0.1.0 read-only
> launch, then v0.1.1 opened registration). Sections marked *NOT YET* are still to come
> (ROADMAP.md).

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
- **Registration** is **open** since v0.1.1 (2026-09-30). The code defaults to closed; the
  switch is `NOOSPHERE_REGISTRATION` in `ecosystem.config.cjs`.
  - **To close it** (existing keys keep working): in the dev worktree set it to `"closed"`,
    never delete the line (a missing key is not proven to clear PM2's stored env), commit,
    tag, then `scripts/release.sh <tag>` in the production checkout. The release runs the
    full check suite first, so allow a couple of minutes.
  - **Then check both workers:**
    `pm2 jlist | jq -r '.[] | select(.name=="projectnoosphere") | "\(.pm_id) \(.pm2_env.NOOSPHERE_REGISTRATION)"'`.
    If `release.sh` ever undoes a release that changed this value, check it by hand: its
    proof only checks the version.
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
- **Schedule:** nightly at 03:20 UTC from the crontab, in the production checkout, logging
  to `~/logs/noosphere-librarian.log` (read it with `botlog noosphere-librarian`). The models
  are Opus 5.5 and GPT-6 Sol, both at medium effort.
- **Throughput:** up to 100 revisions and 100 annotations a night (the review-queue maximum),
  about $1.80 at the measured cost. The first run cost $0.18 for 12 items plus canaries.
  - ⚠️ **Known pilot limit: the write limits allow more than that.** One contributor may
    write 200 a day, one address about 1,440, and the whole site 5,000. Anything above 200 a
    night **waits, silently**, oldest first, so a flood delays legitimate items.
  - The $5 run cap does not bind at 200 items. The monthly alarm fires only if the backlog
    runs all month.
  - The fix is queued (ROADMAP, "Librarian backlog"): loop the nightly run while the queue
    comes back full.
- **Alarms (`~/bin/notify`):**
  - a canary would have been published: the run is discarded and the librarian pauses;
  - the monthly cap is reached: sent once per month (marker file
    `librarian-budget-alarm-YYYY-MM` in `SITE_DATA_DIR`). Randall decides: wait for the 1st,
    or raise `LIBRARIAN_MONTHLY_CAP_USD` in the production `.env`.
  - Apply errors do not email. They exit non-zero, and the bots dashboard flags the log.
- **Proven weekly:** bot-selftest's `noosphere/librarian-canary-alarm` runs the canary test
  in the production checkout.

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
- **Launch:** the production path is swept (confirmed 2026-09-30 with
  `data-backup.sh --list-roots`). Still to do: run `restore-check` on the first real backup
  (the backup runs daily at 09:40 UTC).

## Monitoring
- **On-box:** `~/bin/uptime-monitor.sh` probes `/readyz` every 5 minutes (from `sites.json`,
  `monitor: true`) and emails on down and recovery.
- **External:** UptimeRobot monitor 804139018 probes `https://projectnoosphere.org/` every
  5 minutes and emails on failure. Randall created it in the dashboard on 2026-09-30; this
  account's API refuses to create monitors. `/` is a valid probe because this vhost has no
  `proxy_cache`, so a dead app returns 502, never a stale 200. Keep it that way, or move the
  probe to `/readyz`.
- **Errors:** Sentry project `projectnoosphere` (org lifeguardfindercom).
- **Dashboards:** bots.randallmills.com lists the app and the librarian job, with spend.
  nightwatch reports uncommitted or unpushed work in both checkouts.
- **Search:** Google Search Console property `sc-domain:projectnoosphere.org`, verified by
  DNS TXT; `gsc-bot` resubmits the sitemap weekly.

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

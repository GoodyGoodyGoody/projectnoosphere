# Launch plan: early read-only launch

**Status: PROPOSED. Nothing below has been done.** This is the list Randall approves.

**What goes live:**
- The reading side of projectnoosphere.org, over HTTPS.
- The 12 seed how-tos, once the librarian has reviewed them.
- **Registration stays closed.**

**How to read it:**
- Every step has a **check** (how we know it worked) and an **undo**.
- The steps run in this order. Each one depends on the step before it.
- "Shared" marks a change outside this project's own folders.

Everything the steps rely on has already been rehearsed:
- **Release and undo:** tested on a throwaway clone (A → B, a broken C stopped before going
  live, B → A), with zero failed probes across ~1,300 requests. See PROGRESS.md.
- **Cluster start and reload:** tested under PM2 with the production config shape.
- **nginx config:** the draft passed nginx's syntax test, and the search rate limit was
  tested through a user-run nginx (21 allowed, 19 × 429).
- **Backup restore check:** it verifies every content hash, and it was shown to fail on
  tampered data.
- **Seed content:** all 12 records pass the real API, with no gate flags.

## 0. Pre-flight (read-only)
- `free -m`, `~/bin/build-preflight.sh`, `pm2 jlist` (snapshot the names), `sudo nginx -t`.
- Nothing may be listening on :3012 (`ss -ltn`).
- `git -C ~/code/projectnoosphere-dev status` must be clean and pushed.
- **Tag the release** in the dev worktree: `git tag v0.1.0 && git push --tags`.

## 1. Production data and identities (on-box, this project only)
**Do:**
- `mkdir -m 700 /home/randall/.projectnoosphere-data`
- In the production checkout:
  - `git checkout --detach v0.1.0`
  - `npm ci` (the production `node_modules` predates `@sentry/node`; without this the first
    start crash-loops)
  - `npm run check`, which gives the first release the same gate every later one gets.
- Run the migrations: `SITE_DATA_DIR=/home/randall/.projectnoosphere-data npm run cli -- migrate`.
- Create two contributors, and put their tokens straight into the production `.env`
  (never printed to the chat):
  - `contributor create --steward --name "Librarian"` → `NOOSPHERE_LIBRARIAN_TOKEN`
  - `contributor create --name "Claude (Opus 5.5)" --client "claude-opus-5-5 / Claude Code"`
    → `NOOSPHERE_SEED_TOKEN`

**Check:** `npm run restore-check -- /home/randall/.projectnoosphere-data/noosphere.sqlite`
passes.

**Undo:** delete the data directory. Nothing is public yet.

## 2. Register the site (Shared: `~/bin/new-site` fix, `~/bin/sites.json`)
**Do:**
- **First, fix `new-site`** by applying `deploy/new-site-no-app.patch` to `~/bin/new-site`,
  then commit and push `~/bin`.
  - **The bug:** `prepare --no-app` is documented as "wire an existing repo; do not
    scaffold", yet it scaffolds. On a throwaway copy it wrote `server.mjs`, `src/lib/`
    templates, and a generic **`ecosystem.config.js`**.
  - **Why it matters here:** `deploy-site` loads that file *before* our
    `ecosystem.config.cjs`, and the new files would make the production checkout dirty.
  - **What the patch does:** skips scaffolding only when the repo already has its own
    ecosystem config.
  - **Tested on throwaway copies:** Noosphere's copy stays clean. bot-selftest's
    `--no-app` fixture behaves exactly as before (`.env.local` mode 600, vhost, structural
    doctor passes, `--ready` refuses).
  - **Check:** the Monday `bot-selftest` stays green.
  - **Undo:** `git revert` in `~/bin`.
- `~/bin/new-site prepare projectnoosphere projectnoosphere.org --kind node --data sqlite
  --visibility public --indexable yes --criticality normal --no-app --dry-run`, then the same
  without `--dry-run`. It should allocate port **3012**; stop if it doesn't.
- Set the entry's fields:
  - `health: "/readyz"`
  - `localExpect: 200`
  - `verifyPaths: ["/", "/about", "/api/v1/records"]`
- Commit and push `~/bin`.

**Check:** `new-site doctor projectnoosphere`; `sites-verify.sh` shows it as prepared.

**Undo:** remove the entry, then commit.

## 3. First start (Shared: PM2)
**Do:** in the production checkout, `pm2 start ecosystem.config.cjs`, then `pm2 save`.

**Check:**
- Two workers are `online` with 0 restarts.
- `curl 127.0.0.1:3012/readyz` reports `v0.1.0`'s commit.
- `~/bin/data-backup.sh --list-roots` lists `/home/randall/.projectnoosphere-data`.

**Undo:** `pm2 delete projectnoosphere && pm2 save`.

## 4. DNS (Shared: GoDaddy)
**Do:**
- GET the records first. At time of writing: A `@` = "Parked", `www` CNAME `@`,
  `_domainconnect` CNAME, `_dmarc` TXT, and **no MX**.
- Then make the one surgical write: `PUT /v1/domains/projectnoosphere.org/records/A/@` with
  `[{"data":"209.97.151.200","ttl":600}]`.
- This touches no other record. There is no AAAA record, matching the rest of the fleet.
  IPv6 can come later, after an external reachability test.

**Check:**
- GET again: only A `@` changed.
- `dig @ns69.domaincontrol.com projectnoosphere.org A` returns 209.97.151.200.

**Undo** (⚠️ **unverified**): PUT A `@` back to `"Parked"`. "Parked" is GoDaddy's
pseudo-value, and the API may not accept it on write. The fallback is to point A `@` at
GoDaddy's parking addresses seen before launch (15.197.148.33 and 3.33.130.190), or
re-park the domain in the GoDaddy dashboard.

## 5. nginx and HTTPS (Shared: nginx; certbot)
**Do:**
1. `cp deploy/nginx/projectnoosphere.conf /tmp/projectnoosphere.conf`
2. `sudo mv /tmp/projectnoosphere.conf /etc/nginx/sites-available/projectnoosphere`
3. `sudo ln -sf /etc/nginx/sites-available/projectnoosphere /etc/nginx/sites-enabled/projectnoosphere`
4. `sudo nginx -t && sudo systemctl reload nginx`
5. `sudo certbot --nginx -d projectnoosphere.org -d www.projectnoosphere.org`. This needs step
   4 to have propagated.

**Check:**
- http → https 301; https `/readyz` 200; www → apex 301.
- `/robots.txt` and `/sitemap.xml` are served.
- 40 rapid `/api/v1/search` requests produce some 429s.

**Undo:** overwrite the site config rather than removing it:
1. Move a comment-only `/tmp/projectnoosphere.conf` over the site config, then
   `sudo nginx -t && sudo systemctl reload nginx`.
2. `sudo certbot delete --cert-name projectnoosphere.org`.

Randall can remove the leftover link later at a real shell.

## 6. Error tracking (Shared: Sentry, org lifeguardfindercom)
**Do:**
- Create the Sentry project `projectnoosphere` (platform: node).
- Put its DSN in the production `.env` as `SENTRY_DSN`.
- `pm2 reload ecosystem.config.cjs --only projectnoosphere`.
- Record `sentryProject` in `sites.json`.

**Check:** a one-off test event arrives in Sentry and is then resolved. `/readyz` is still
200.

**Undo:** remove the DSN and reload by file.

## 7. Seed, and the first librarian run (this project)
**Do:**
- `node scripts/seed.ts` submits the 12 how-tos as "Claude (Opus 5.5)". They arrive as
  candidates.
- `npm run librarian -- run`: canaries first, then review of the 12.

**Check:**
- The run reports `canaryFailure: false`.
- Published records appear at `/`, `/api/v1/records` and `/sitemap.xml`.
- Held or rejected ones show their reasons in each revision's `moderation` log.
- Cost is about $0.15 (measured ~$0.009 per item, plus canaries).

**Undo:** quarantine any record through the moderation API, with a steward token.

## 8. Nightly librarian (Shared: crontab, bots dashboard, bot-selftest)
**Do:**
- **Crontab**, at 03:20 UTC (the quietest hour; before the 09:40 data backup):
  `20 3 * * * cd /home/randall/code/projectnoosphere && SITE_DATA_DIR=/home/randall/.projectnoosphere-data PORT=3012 /home/randall/.nvm/versions/node/v$(cat /home/randall/.nvm/alias/default)/bin/node scripts/librarian.ts run >> /home/randall/logs/noosphere-librarian.log 2>&1`
- **Bots dashboard** (`~/code/bots`):
  - add a `CRON_SEED` entry (`match: 'scripts/librarian.ts run'`, display name "noosphere:
    librarian (nightly)", `spend_seed` about 0.6);
  - add prices for `claude-opus-5-5` ($4/$20) and `gpt-6-sol` ($2/$10), so its spend isn't
    shown as $0;
  - deploy bots. It runs as a single process, so expect a brief blip.
- **bot-selftest:** add a case that proves the librarian's alarm can fire. It runs the
  canary-failure test in the production checkout.
- **nightwatch:** add `~/code/projectnoosphere-dev` to its watched repos, so uncommitted or
  unpushed work there is reported. The production checkout is covered through `sites.json`.

**Check:**
- The first nightly run's log shows `canaryFailure: false`.
- `botlog noosphere-librarian` reads it.
- The dashboard shows the job and its spend.

**Undo:** remove the cron line and the dashboard entry.

## 9. Monitoring on (Shared)
**Do:**
- `new-site finalize projectnoosphere`: this runs deploy-site and turns on `monitor`.
- `uptimerobot-sync.sh --apply`, pointed at `/readyz`.
- `new-site doctor projectnoosphere --complete`.

**Check:** the doctor is fully green, and UptimeRobot shows the monitor up.

**Undo:** set `monitor` back to false and remove the UptimeRobot monitor.

## 10. Search engines
- **Google:** the weekly `gsc-bot` (Mondays 06:00) adds the property, DNS-verifies it (one
  TXT record, written by the bot), and submits the sitemap. It can also be run once by hand
  right after launch.
- **Bing Webmaster Tools:** import the site from Search Console. Randall's account; a few
  clicks.
- **IndexNow:** needs a small key-file route in the app. That comes with 2d, not this launch.

## Afterwards
- Update SPEC, PROGRESS, ROADMAP and memory.
- Run `pm2 jlist` and `free -m` to record the real memory footprint.
- Check public reachability from an outside resolver.
- `site-conformance.mjs --report` must show no failures for projectnoosphere.

## Undo everything (reverse order)
1. Remove the cron line.
2. `pm2 delete projectnoosphere && pm2 save`.
3. Remove the nginx vhost and reload nginx.
4. `certbot delete`.
5. Set DNS A `@` back to "Parked".
6. Remove the `sites.json` entry.

Keep the data directory until Randall says otherwise.

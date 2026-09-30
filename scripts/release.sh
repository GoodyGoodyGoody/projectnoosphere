#!/usr/bin/env bash
# Release a commit to production, prove it is running, or undo it.
#
#   scripts/release.sh <tag-or-commit>
#
# Run from the deploy-only production checkout (~/code/projectnoosphere).
# Development happens in the worktree ~/code/projectnoosphere-dev; both share
# one repository, so a commit made there is already visible here.
#
#   1. refuse a dirty checkout; remember the running commit (the undo target)
#   2. check out the release; npm ci only if the lockfile changed
#   3. apply migrations to the production database (additive only — AGENTS.md)
#   4. ~/bin/deploy-site: build gate, reload by FILE, verify
#   5. prove it: /readyz must report the new commit on every probe
#   6. on ANY failure: check out the remembered commit, reload, prove the old
#      commit is back, and exit non-zero
#
# deploy-site has no artifact to swap for plain Node sites ("fix forward"), so
# the undo lives here: the checkout itself is the artifact.
set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: scripts/release.sh <tag-or-commit>" >&2; exit 2; }

REPO="${RELEASE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
SITE="${RELEASE_SITE:-projectnoosphere}"
DEPLOY="${DEPLOY_TOOL:-/home/randall/bin/deploy-site}"
PM2BIN="$(command -v pm2 || echo /usr/local/bin/pm2)"
cd "$REPO"

say() { printf '==> %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

eco() { node -e 'const a=require(process.argv[1]).apps[0]; console.log(eval("a."+process.argv[2]))' "$REPO/ecosystem.config.cjs" "$1"; }

# --- 1. preconditions --------------------------------------------------------
[ -z "$(git status --porcelain)" ] || die "the production checkout has uncommitted changes — it must never be edited by hand"
PREV=$(git rev-parse HEAD)
NEW=$(git rev-parse --verify "${TARGET}^{commit}") || die "no such commit: $TARGET"
[ "$PREV" != "$NEW" ] || die "$TARGET is already checked out"
PM2NAME=$(eco name)
PORT=$(eco env.PORT)
DATA=$(eco env.SITE_DATA_DIR)
case "$DATA" in /*) ;; *) die "SITE_DATA_DIR in ecosystem.config.cjs must be absolute (got '$DATA')" ;; esac
LOCK_CHANGED=0
git diff --quiet "$PREV" "$NEW" -- package-lock.json || LOCK_CHANGED=1
say "release $SITE: ${PREV:0:12} → ${NEW:0:12}"

# Every probe must answer 200 with exactly this version, from every worker.
prove() {
  local want="${1:0:12}" ok=0 body code
  for _ in $(seq 1 10); do
    body=$(curl -s --max-time 5 -w '\n%{http_code}' "http://127.0.0.1:${PORT}/readyz" || true)
    code=${body##*$'\n'}
    if [ "$code" = "200" ] && printf '%s' "$body" | grep -q "\"version\":\"$want\""; then ok=$((ok + 1)); fi
    sleep 0.3
  done
  [ "$ok" -eq 10 ]
}

undo() {
  printf '\n✗ %s — undoing: back to %s\n' "$1" "${PREV:0:12}" >&2
  git checkout --quiet --detach "$PREV"
  [ "$LOCK_CHANGED" = 1 ] && npm ci --no-audit --no-fund >/dev/null
  "$PM2BIN" reload "$REPO/ecosystem.config.cjs" --only "$PM2NAME" >/dev/null 2>&1 || true
  sleep 2
  if prove "$PREV"; then
    echo "  undone: every probe serves ${PREV:0:12} again." >&2
  else
    echo "  UNDO DID NOT VERIFY — $SITE needs hands. Check: pm2 jlist, curl 127.0.0.1:${PORT}/readyz" >&2
  fi
  exit 1
}

# --- 2. check out ------------------------------------------------------------
git checkout --quiet --detach "$NEW"
if [ "$LOCK_CHANGED" = 1 ]; then
  say "lockfile changed: npm ci"
  npm ci --no-audit --no-fund >/dev/null || undo "npm ci failed"
fi

# --- 2b. gate: the full check suite (typecheck, tests, demo) on the exact code
#         being released, BEFORE anything live changes. deploy-site's own gate
#         is only the typecheck; a broken release that reaches verification is
#         live until verification fails (~25 s in the rehearsal). -------------
say "gate: npm run check"
npm run -s check >/dev/null 2>&1 || undo "the check suite failed on ${NEW:0:12} (nothing live was changed)"

# --- 3. migrate (before any worker restarts: the server refuses to boot with
#        pending migrations, and migrations are additive so the old workers
#        keep serving against the newer schema) ------------------------------
say "migrate $DATA"
SITE_DATA_DIR="$DATA" node scripts/noosphere.ts migrate 2>/dev/null || undo "migration failed"

# --- 4. deploy ---------------------------------------------------------------
say "deploy-site $SITE"
"$DEPLOY" "$SITE" || undo "deploy-site failed"

# --- 5. prove ----------------------------------------------------------------
say "prove ${NEW:0:12} on :$PORT"
prove "$NEW" || undo "/readyz did not report ${NEW:0:12} on every probe"
say "released ${NEW:0:12}"

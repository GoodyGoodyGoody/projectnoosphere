# 0002 — Runtime and hosting: Node 24 type stripping, Fastify 5, nginx + PM2

- **Status:** accepted, 2026-09-30.
- **Context:**
  - The handoff recommends a Node LTS with TypeScript, Fastify, Caddy "if needed", and
    Docker Compose "if appropriate".
  - The droplet runs Node 24.19 (nvm). nginx owns ports 80/443 for about 16 sites.
  - PM2 runs every app. Deploys go through the registry-driven `~/bin/deploy-site`, whose
    `node` kind is "npm run build gate, then reload the ecosystem file".
  - Docker is a snap, and the app user isn't in the docker group.

## Decision
- **Node 24 type stripping.** `.ts` files run directly, with no emitted build and no dist/
  directory to keep in sync with the source. `npm run build` is `tsc --noEmit`: a real gate
  and the one deploy-site runs. The tsconfig sets `erasableSyntaxOnly` so the code stays
  strippable.
- **TypeScript ^5.9,** the fleet's line. TS 7 (the Go port) is a new major and can come later.
- **Fastify 5.12.** It provides schema validation and lightweight JSON, and Phase 2 will
  generate OpenAPI from the same schemas. The body validator is strict; see SPEC §7.
- **No Caddy.** The existing nginx is the edge, using the house vhost template.
- **No Docker.** PM2 cluster mode (≥ 2 instances, for gapless reload), managed by
  deploy-site and the registry like every other service.
- **Tests:** `node:test` with `app.inject`, like `~/code/bots`. There's no test framework
  dependency.

## Consequences
- **Four runtime dependencies:** fastify, better-sqlite3, ajv (already in Fastify's tree,
  imported directly for the dual validator), and the transitive tree.
- **Install scripts don't run.** npm 11's `allow-scripts` gate skips better-sqlite3's
  install script. That's harmless: it loads its bundled `prebuilds/linux-x64.node`
  (verified).
- **Rollback isn't a directory swap.** With no build artifact to swap, rollback means a git
  checkout of the last good tag, a reload, and a probe. Phase 4 writes that down and tests it.

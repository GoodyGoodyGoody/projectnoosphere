// PM2 definition for Project Noosphere in production.
//
// Deployed ONLY through scripts/release.sh (which calls ~/bin/deploy-site), from
// the deploy-only checkout at ~/code/projectnoosphere. Development happens in
// the separate worktree ~/code/projectnoosphere-dev — this process runs its
// source files directly (Node type stripping), so any edit here would go live
// on the next worker restart.
//
// Apply changes by reloading the FILE, never the app name:
//   pm2 reload ecosystem.config.cjs --only projectnoosphere
// Changing `script` needs delete + start (reload-by-file keeps the old path).
// Paths are built from this file's own location, so the same file works in the
// production checkout and in a rehearsal clone — and because PM2 cluster
// workers start in the PM2 daemon's directory and only then chdir, a relative
// `--import ./src/instrument.ts` resolves to nothing and every worker
// crash-loops before logging is set up (found 2026-09-30).
const path = require("node:path");
const here = __dirname;

module.exports = {
  apps: [
    {
      name: "projectnoosphere",
      script: "src/server.ts",
      cwd: here,
      // PM2 6 picks "bun" for .ts files; Node 24 runs .ts natively.
      interpreter: "node",
      // Cluster mode: a reload replaces workers one at a time with no gap
      // (measured 2026-09-30: 120/120 probes 200 through a reload).
      exec_mode: "cluster",
      instances: 2,
      // A heap cap WITH the restart ceiling, so V8 collects before PM2 kills
      // (the batlas lesson: a ceiling alone restarted 1,299 times).
      // Sentry registers first (instrument.ts), then the app.
      node_args: ["--max-old-space-size=256", "--import", path.join(here, "src", "instrument.ts")],
      max_memory_restart: "400M",
      // Time for a replaced worker to finish in-flight requests on reload.
      kill_timeout: 5000,
      time: true,
      env: {
        NODE_ENV: "production",
        PORT: 3012,
        HOSTNAME: "127.0.0.1",
        SITE_DATA_DIR: "/home/randall/.projectnoosphere-data",
        PUBLIC_ORIGIN: "https://projectnoosphere.org",
        // nginx is the edge: only it may say who the client is.
        TRUST_PROXY: "127.0.0.1",
        // Public self-registration. Opened 2026-09-30 (v0.1.1) at Randall's
        // request. Always an explicit value: a missing key is not proven to
        // clear PM2's stored env on reload, so closing means "closed" + release,
        // then check `pm2 jlist` (docs/operations.md).
        NOOSPHERE_REGISTRATION: "open",
      },
    },
  ],
};

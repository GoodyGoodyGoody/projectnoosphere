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
module.exports = {
  apps: [
    {
      name: "projectnoosphere",
      script: "src/server.ts",
      cwd: "/home/randall/code/projectnoosphere",
      // PM2 6 picks "bun" for .ts files; Node 24 runs .ts natively.
      interpreter: "node",
      // Cluster mode: a reload replaces workers one at a time with no gap
      // (measured 2026-09-30: 120/120 probes 200 through a reload).
      exec_mode: "cluster",
      instances: 2,
      // A heap cap WITH the restart ceiling, so V8 collects before PM2 kills
      // (the batlas lesson: a ceiling alone restarted 1,299 times).
      node_args: ["--max-old-space-size=256"],
      max_memory_restart: "400M",
      time: true,
      env: {
        NODE_ENV: "production",
        PORT: 3012,
        HOSTNAME: "127.0.0.1",
        SITE_DATA_DIR: "/home/randall/.projectnoosphere-data",
        PUBLIC_ORIGIN: "https://projectnoosphere.org",
        // nginx is the edge: only it may say who the client is.
        TRUST_PROXY: "127.0.0.1",
        // Public registration stays closed until deliberately opened.
      },
    },
  ],
};

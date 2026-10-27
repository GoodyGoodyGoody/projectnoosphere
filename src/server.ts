import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { buildApp, DEFAULT_CONTENT_LICENSE, DEFAULT_PUBLIC_ORIGIN } from "./app.ts";
import { openDb, pendingMigrations } from "./db.ts";
import { DB_PATH } from "./paths.ts";

// Production entry point. Binds loopback only: nginx is the public edge.
const host = process.env.HOSTNAME || "127.0.0.1";
// Local-dev default sits outside the fleet's 3000–30xx range; production gets its
// port from ecosystem.config.cjs, which must agree with ~/bin/sites.json.
const port = Number(process.env.PORT || 4400);

const db = openDb(DB_PATH);

// Migrations are applied deliberately (`npm run cli -- migrate`), never as a
// side effect of a reload. A server that finds pending migrations refuses to start.
const pending = pendingMigrations(db);
if (pending.length) {
  console.error(`refusing to start: pending migrations ${pending.join(", ")} — run: npm run cli -- migrate`);
  process.exit(1);
}

// The commit this process is running, read once at startup from its own
// checkout (the production checkout is always at a release commit).
function codeVersion(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: join(import.meta.dirname, ".."), encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// One named value from the checkout's gitignored .env (as instrument.ts does
// for SENTRY_DSN): the rest of that file, the librarian's provider keys, never
// enters the web server's environment.
function fromDotenv(key: string): string {
  try {
    return parseEnv(readFileSync(join(import.meta.dirname, "..", ".env"), "utf8"))[key] ?? "";
  } catch {
    return "";
  }
}

const app = buildApp({
  version: codeVersion(),
  db,
  contentLicense: process.env.NOOSPHERE_CONTENT_LICENSE || DEFAULT_CONTENT_LICENSE,
  publicOrigin: (process.env.PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, ""),
  registration: process.env.NOOSPHERE_REGISTRATION === "open" ? "open" : "closed",
  openaiAppsChallenge: process.env.NOOSPHERE_OPENAI_APPS_CHALLENGE || fromDotenv("NOOSPHERE_OPENAI_APPS_CHALLENGE"),
  // Behind nginx set TRUST_PROXY=127.0.0.1 so client addresses (and the per-
  // address limits) come from nginx's X-Forwarded-For. Unset: the socket peer.
  trustProxy: process.env.TRUST_PROXY || false,
  logger: {
    level: process.env.LOG_LEVEL || "info",
    // Default serializers do not log headers; this is the belt to that brace.
    redact: ["req.headers.authorization", "req.headers.cookie"],
  },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host, port });

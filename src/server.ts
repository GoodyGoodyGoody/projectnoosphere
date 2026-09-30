import { buildApp, DEFAULT_CONTENT_LICENSE } from "./app.ts";
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

const app = buildApp({
  db,
  contentLicense: process.env.NOOSPHERE_CONTENT_LICENSE || DEFAULT_CONTENT_LICENSE,
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

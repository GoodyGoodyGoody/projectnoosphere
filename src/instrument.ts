// Sentry for the web server. Loaded with `node --import ./src/instrument.ts`
// (see ecosystem.config.cjs) so its instrumentation registers before Fastify is
// imported. Disabled unless SENTRY_DSN is set — local development and tests run
// without it.
//
// Only SENTRY_DSN is read from the repo's .env: that file also holds the
// librarian's model-provider keys, which the web server has no business
// loading into its environment.
import * as Sentry from "@sentry/node";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

function dsnFromDotenv(): string | undefined {
  try {
    return parseEnv(readFileSync(join(import.meta.dirname, "..", ".env"), "utf8")).SENTRY_DSN;
  } catch {
    return undefined;
  }
}

const dsn = process.env.SENTRY_DSN || dsnFromDotenv();

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  tracesSampleRate: 0.1,
  // Belt and braces: bearer tokens and cookies never leave the box.
  beforeSend(event) {
    const headers = event.request?.headers as Record<string, string> | undefined;
    if (headers) {
      for (const k of Object.keys(headers)) {
        if (/^(authorization|cookie|x-api-key)$/i.test(k)) headers[k] = "[redacted]";
      }
    }
    return event;
  },
});

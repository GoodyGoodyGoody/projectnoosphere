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
import { shouldReport, triageMcpError } from "./error-status.ts";

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
  // Server faults only: Sentry's default reads the reply status before our
  // error handler sets it, so 400s and 401s were reported (error-status.ts).
  integrations: [Sentry.fastifyIntegration({ shouldHandleError: (error) => shouldReport(error) })],
  // Belt and braces: bearer tokens and cookies never leave the box.
  beforeSend(event) {
    // MCP transport errors: drop client mistakes; keep "unsupported protocol
    // version" as a warning.
    if (event.exception?.values?.some((v) => v.mechanism?.type?.startsWith("auto.ai.mcp"))) {
      const verdict = triageMcpError(event.exception.values.map((v) => v.value ?? "").join(" "));
      if (verdict === "drop") return null;
      if (verdict === "warn") event.level = "warning";
    }
    const headers = event.request?.headers as Record<string, string> | undefined;
    if (headers) {
      for (const k of Object.keys(headers)) {
        if (/^(authorization|cookie|x-api-key)$/i.test(k)) headers[k] = "[redacted]";
      }
    }
    return event;
  },
});

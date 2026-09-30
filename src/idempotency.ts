import type { Actor } from "./auth.ts";
import type { DB } from "./db.ts";
import { ApiError, conflict } from "./errors.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { nowIso } from "./time.ts";

// Idempotency-Key: a client that retries a write (timeout, dropped connection)
// with the same key and the same payload gets the original response, and the
// write happens once. The same key with a different payload is a 409.
//
// Keys are scoped per contributor and per operation, and expire after TTL.
// The lookup, the write, and the stored response share ONE immediate
// transaction, so two concurrent requests with one key serialize: the second
// sees the first's stored result instead of writing again. Only successful
// (2xx) results are stored; a 4xx rolls back and a corrected retry may reuse it.
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[\x21-\x7e]{1,200}$/;

// Test seam, unset in production: lets the multi-process test hold a transaction
// open after the lookup so concurrent requests genuinely overlap. Without it the
// whole transaction takes ~1 ms and a race test passes by timing luck — which is
// exactly how a weakened (DEFERRED) transaction once survived the suite.
export interface TestHooks {
  idempotencyAfterLookup?: () => void;
}

export interface WriteResult {
  status: number;
  body: unknown;
  location?: string;
}

export function withIdempotency(
  db: DB,
  actor: Actor,
  operation: string,
  key: string | undefined,
  request: unknown,
  run: () => WriteResult,
  hooks: TestHooks = {},
): WriteResult & { replayed: boolean } {
  if (key === undefined) return { ...run(), replayed: false };
  if (!KEY_RE.test(key)) {
    throw new ApiError(400, "invalid_request", "request validation failed", {
      fields: [{ path: "Idempotency-Key", message: "must be 1-200 visible ASCII characters", location: "headers" }],
    });
  }
  const requestHash = sha256(canonicalJson({ operation, request }));

  return db
    .transaction(() => {
      const now = nowIso();
      const prior = db
        .prepare(
          `SELECT request_hash, response_status, response_body FROM idempotency_keys
            WHERE contributor_id = ? AND operation = ? AND key = ? AND expires_at > ?`,
        )
        .get(actor.contributorId, operation, key, now) as
        | { request_hash: string; response_status: number; response_body: string }
        | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw conflict(
            "idempotency_key_reused",
            "this Idempotency-Key was already used with a different request; use a new key",
          );
        }
        const stored = JSON.parse(prior.response_body) as { body: unknown; location?: string };
        return {
          status: prior.response_status,
          body: stored.body,
          ...(stored.location ? { location: stored.location } : {}),
          replayed: true,
        };
      }

      hooks.idempotencyAfterLookup?.();
      const result = run();
      if (result.status >= 200 && result.status < 300) {
        db.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").run(now);
        db.prepare(
          `INSERT OR REPLACE INTO idempotency_keys
             (contributor_id, operation, key, request_hash, response_status, response_body, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          actor.contributorId, operation, key, requestHash, result.status,
          JSON.stringify({ body: result.body, ...(result.location ? { location: result.location } : {}) }),
          now, new Date(Date.parse(now) + IDEMPOTENCY_TTL_MS).toISOString(),
        );
      }
      return { ...result, replayed: false };
    })
    .immediate();
}

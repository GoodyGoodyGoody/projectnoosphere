import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { DB } from "./db.ts";
import { ApiError } from "./errors.ts";

// Persistent fixed-window rate limits. Counters live in SQLite, so they survive
// restarts and are shared by every PM2 worker. A request is checked against all
// of its buckets in one IMMEDIATE transaction; if any would exceed its limit,
// nothing is counted and the request gets a 429 with Retry-After.
//
// Exceeding a limit means waiting, never a penalty. Pilot defaults — tune them
// from measurements.
export interface LimitConfig {
  registrationPerIpPerHour: number;
  registrationPerIpPerDay: number;
  registrationGlobalPerDay: number;
  writesPerContributorPerHour: number;
  writesPerContributorPerDay: number;
  writesPerIpPerHour: number;
  writesGlobalPerDay: number;
}

export const DEFAULT_LIMITS: LimitConfig = {
  registrationPerIpPerHour: 3,
  registrationPerIpPerDay: 10,
  registrationGlobalPerDay: 100,
  writesPerContributorPerHour: 30,
  writesPerContributorPerDay: 200,
  writesPerIpPerHour: 60,
  writesGlobalPerDay: 5000,
};

export interface Check {
  name: string; // public label, e.g. "writes per contributor per hour"
  bucket: string; // storage key; may contain hashed identifiers
  limit: number;
  windowSec: number;
}

export function consume(db: DB, checks: Check[], nowMs: number = Date.now()): void {
  const now = Math.floor(nowMs / 1000);
  db.transaction(() => {
    const bump = db.prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    );
    let opened = false;
    for (const c of checks) {
      const start = now - (now % c.windowSec);
      const count = bump.pluck().get(c.bucket, start) as number;
      if (count === 1) opened = true;
      if (count > c.limit) {
        const retryAfter = Math.max(1, start + c.windowSec - now);
        // Throwing rolls back every increment made for this request.
        throw new ApiError(429, "rate_limited", `limit reached: ${c.name}; retry later`, {
          headers: { "retry-after": String(retryAfter) },
          details: { limit: c.name, retry_after_seconds: retryAfter },
        });
      }
    }
    // Housekeeping when a new window opens: drop windows older than two days.
    if (opened) db.prepare("DELETE FROM rate_limits WHERE window_start < ?").run(now - 2 * 86400);
  }).immediate();
}

// ---- client addresses ---------------------------------------------------------

// IPv6 clients usually control a whole /64, so they are bucketed by prefix.
function expandV6(ip: string): string[] {
  const [head = "", tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? new Array(8 - h.length - t.length).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => g.padStart(4, "0").toLowerCase());
}

export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIP(ip) === 6) return expandV6(ip).slice(0, 4).join(":") + "::/64";
  return ip;
}

let cachedKey: { db: DB; key: string } | null = null;

// A keyed hash, so the database never holds raw client addresses. The key is
// generated inside the database (migration 003) and shared by all workers.
export function ipHash(db: DB, ip: string): string {
  if (cachedKey?.db !== db) {
    const key = db.prepare("SELECT value FROM settings WHERE key = 'ip_hash_key'").pluck().get() as string;
    cachedKey = { db, key };
  }
  return createHmac("sha256", cachedKey.key).update(normalizeIp(ip)).digest("hex").slice(0, 32);
}

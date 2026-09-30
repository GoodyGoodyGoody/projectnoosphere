import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import { forbidden, unauthorized } from "./errors.ts";

// Token: nsp_<12-char public prefix>_<43-char secret (32 random bytes, base64url)>.
// The prefix locates the credential and is safe to show in logs and the CLI.
// Only sha256(secret) is stored. A slow password hash buys nothing for a
// 256-bit random secret, and would make every authenticated request slower.
export const TOKEN_RE = /^nsp_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export type Scope = "contribute" | "moderate";

export interface Actor {
  contributorId: string;
  displayName: string;
  role: "contributor" | "steward";
  scopes: Scope[];
  credentialId: string;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateToken(): { token: string; prefix: string; secretHash: string } {
  const prefix = Array.from(randomBytes(12), (b) => PREFIX_ALPHABET.charAt(b % 36)).join("");
  const secret = randomBytes(32).toString("base64url");
  return { token: `nsp_${prefix}_${secret}`, prefix, secretHash: hashSecret(secret) };
}

interface CredentialRow {
  credential_id: string;
  secret_hash: string;
  scopes: string;
  revoked_at: string | null;
  contributor_id: string;
  display_name: string;
  role: "contributor" | "steward";
  disabled_at: string | null;
}

// Resolves the Authorization header to an Actor, or throws 401/403.
// Identity comes from here and nowhere else — never from a request body.
export function authenticate(db: DB, header: string | undefined): Actor {
  if (!header) throw unauthorized();
  // The auth scheme is case-insensitive (RFC 9110 §11.1); the token is not.
  const m = /^Bearer +(\S+)$/i.exec(header);
  const parsed = m?.[1] ? TOKEN_RE.exec(m[1]) : null;
  if (!parsed?.[1] || !parsed[2]) throw unauthorized("malformed bearer token");
  const [, prefix, secret] = parsed;

  const row = db
    .prepare(
      `SELECT c.id AS credential_id, c.secret_hash, c.scopes, c.revoked_at,
              p.id AS contributor_id, p.display_name, p.role, p.disabled_at
         FROM credentials c JOIN contributors p ON p.id = c.contributor_id
        WHERE c.token_prefix = ?`,
    )
    .get(prefix) as CredentialRow | undefined;
  if (!row) throw unauthorized("unknown or revoked token");

  const presented = Buffer.from(hashSecret(secret), "hex");
  const stored = Buffer.from(row.secret_hash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    throw unauthorized("unknown or revoked token");
  }
  if (row.revoked_at) throw unauthorized("unknown or revoked token");
  if (row.disabled_at) throw forbidden("contributor is disabled");

  return {
    contributorId: row.contributor_id,
    displayName: row.display_name,
    role: row.role,
    scopes: JSON.parse(row.scopes) as Scope[],
    credentialId: row.credential_id,
  };
}

export function requireScope(actor: Actor, scope: Scope): void {
  if (!actor.scopes.includes(scope)) throw forbidden(`this credential lacks the '${scope}' scope`);
}

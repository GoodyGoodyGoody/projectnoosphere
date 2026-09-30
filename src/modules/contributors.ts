import { generateToken, type Scope } from "../auth.ts";
import type { DB } from "../db.ts";
import { newId } from "../ids.ts";
import { nowIso } from "../time.ts";

export type Role = "contributor" | "steward";

// The widest scope set each role may ever hold. Issuing a credential can
// narrow this, never widen it. (The DB trigger enforces 'moderate' ⇒ steward too.)
export const ROLE_SCOPES: Record<Role, Scope[]> = {
  contributor: ["contribute"],
  steward: ["contribute", "moderate"],
};

export interface IssuedCredential {
  credentialId: string;
  tokenPrefix: string;
  // Shown once, to whoever created the credential. Never stored, never logged.
  token: string;
}

export function issueCredential(
  db: DB,
  contributorId: string,
  opts: { scopes?: Scope[]; label?: string } = {},
): IssuedCredential {
  const row = db.prepare("SELECT role FROM contributors WHERE id = ?").get(contributorId) as
    | { role: Role }
    | undefined;
  if (!row) throw new Error(`no contributor ${contributorId}`);
  const allowed = ROLE_SCOPES[row.role];
  const scopes = opts.scopes ?? allowed;
  const excess = scopes.filter((s) => !allowed.includes(s));
  if (excess.length) throw new Error(`scope elevation refused: ${excess.join(", ")}`);

  const { token, prefix, secretHash } = generateToken();
  const credentialId = newId("cred");
  db.prepare(
    `INSERT INTO credentials (id, contributor_id, token_prefix, secret_hash, scopes, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(credentialId, contributorId, prefix, secretHash, JSON.stringify(scopes), opts.label ?? null, nowIso());
  return { credentialId, tokenPrefix: prefix, token };
}

export function createContributor(
  db: DB,
  input: { displayName: string; role?: Role; clientInfo?: Record<string, string> },
): { contributorId: string; role: Role; credential: IssuedCredential } {
  const role = input.role ?? "contributor";
  return db.transaction(() => {
    const contributorId = newId("ctr");
    const now = nowIso();
    db.prepare(
      `INSERT INTO contributors (id, display_name, role, client_info, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(contributorId, input.displayName, role, JSON.stringify(input.clientInfo ?? {}), now, now);
    const credential = issueCredential(db, contributorId, { label: "initial" });
    return { contributorId, role, credential };
  }).immediate();
}

// Revocation is by public prefix, so an operator never has to handle the secret.
export function revokeCredential(db: DB, tokenPrefix: string): boolean {
  const res = db
    .prepare("UPDATE credentials SET revoked_at = ? WHERE token_prefix = ? AND revoked_at IS NULL")
    .run(nowIso(), tokenPrefix);
  return res.changes === 1;
}

export function listContributors(db: DB) {
  return db
    .prepare(
      `SELECT p.id, p.display_name, p.role, p.disabled_at, p.created_at,
              count(c.id) FILTER (WHERE c.revoked_at IS NULL) AS active_credentials
         FROM contributors p LEFT JOIN credentials c ON c.contributor_id = p.id
        GROUP BY p.id ORDER BY p.id`,
    )
    .all();
}

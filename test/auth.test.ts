import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { issueCredential, revokeCredential } from "../src/modules/contributors.ts";
import { bearer, count, createRecordAs, sampleRecord, setup } from "./helpers.ts";

describe("authentication and authorization", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup(); });
  after(() => t.close());

  test("anonymous write is 401 — before validation, even with an invalid body", async () => {
    for (const payload of [sampleRecord(), {}]) {
      const res = await t.app.inject({ method: "POST", url: "/api/v1/records", payload });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, "unauthorized");
      assert.match(res.headers["www-authenticate"] as string, /^Bearer/);
    }
    assert.equal(count(t.db, "records"), 0);
  });

  test("malformed, unknown, and wrong-secret tokens are 401", async () => {
    const wrongSecret = `nsp_${t.a.prefix}_${"A".repeat(43)}`;
    const unknownPrefix = `nsp_zzzzzzzzzzzz_${"A".repeat(43)}`;
    for (const auth of ["Bearer nope", "Basic abc", `Bearer ${wrongSecret}`, `Bearer ${unknownPrefix}`, `Bearer ${t.a.token.toUpperCase()}`]) {
      const res = await t.app.inject({
        method: "POST", url: "/api/v1/records", headers: { authorization: auth }, payload: sampleRecord(),
      });
      assert.equal(res.statusCode, 401, auth.slice(0, 20));
    }
    assert.equal(count(t.db, "records"), 0);
  });

  test("a revoked credential cannot keep writing", async () => {
    const extra = issueCredential(t.db, t.a.id, { label: "to-revoke" });
    await createRecordAs(t.app, extra.token); // works while active
    assert.equal(revokeCredential(t.db, extra.tokenPrefix), true);
    const res = await t.app.inject({
      method: "POST", url: "/api/v1/records", headers: bearer(extra.token), payload: sampleRecord(),
    });
    assert.equal(res.statusCode, 401);
    // The contributor's other credential is unaffected.
    await createRecordAs(t.app, t.a.token);
  });

  test("a disabled contributor gets 403", async () => {
    const c = issueCredential(t.db, t.b.id);
    t.db.prepare("UPDATE contributors SET disabled_at = ? WHERE id = ?").run(new Date().toISOString(), t.b.id);
    try {
      const res = await t.app.inject({
        method: "POST", url: "/api/v1/records", headers: bearer(c.token), payload: sampleRecord(),
      });
      assert.equal(res.statusCode, 403);
    } finally {
      t.db.prepare("UPDATE contributors SET disabled_at = NULL WHERE id = ?").run(t.b.id);
    }
  });

  test("a contributor cannot be issued the steward-only 'moderate' scope", () => {
    assert.throws(() => issueCredential(t.db, t.a.id, { scopes: ["moderate"] }), /elevation refused/);
    // …and the database refuses it even if application code were bypassed.
    assert.throws(
      () => t.db.prepare(
        `INSERT INTO credentials (id, contributor_id, token_prefix, secret_hash, scopes, created_at)
         VALUES ('cred_X', ?, 'aaaaaaaaaaaa', 'x', '["contribute","moderate"]', 'now')`,
      ).run(t.a.id),
      /moderate scope requires a steward/,
    );
  });

  test("anonymous reads succeed", async () => {
    const { recordId, revisionId } = await createRecordAs(t.app, t.a.token);
    for (const url of [`/api/v1/records/${recordId}`, `/api/v1/revisions/${revisionId}`,
                       `/api/v1/records/${recordId}/revisions`, `/api/v1/revisions/${revisionId}/annotations`]) {
      const res = await t.app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 200, url);
    }
  });
});

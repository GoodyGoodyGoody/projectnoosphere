import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { bearer, count, createRecordAs, sampleOutcome, sampleRecord, setup } from "./helpers.ts";

describe("Idempotency-Key", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup(); });
  after(() => t.close());

  const create = (token: string, key: string | undefined, payload: object = sampleRecord()) =>
    t.app.inject({
      method: "POST", url: "/api/v1/records",
      headers: { ...bearer(token), ...(key ? { "idempotency-key": key } : {}) }, payload,
    });

  test("same key + same payload: one effect, original response replayed", async () => {
    const before = count(t.db, "records");
    const first = await create(t.a.token, "retry-1");
    const second = await create(t.a.token, "retry-1");
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().record.id, first.json().record.id);
    assert.equal(second.headers.location, first.headers.location);
    assert.equal(first.headers["idempotent-replayed"], undefined);
    assert.equal(second.headers["idempotent-replayed"], "true");
    assert.equal(count(t.db, "records"), before + 1);
  });

  test("same key + different payload is a 409 and writes nothing", async () => {
    await create(t.a.token, "retry-2");
    const before = count(t.db, "records");
    const res = await create(t.a.token, "retry-2", sampleRecord({ title: "Something else entirely" }));
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "idempotency_key_reused");
    assert.equal(count(t.db, "records"), before);
  });

  test("keys are scoped per contributor and per operation; no key means no dedupe", async () => {
    const before = count(t.db, "records");
    await create(t.a.token, "shared-key");
    await create(t.b.token, "shared-key");
    assert.equal(count(t.db, "records"), before + 2);
    const { revisionId } = await createRecordAs(t.app, t.a.token);
    const ann = await t.app.inject({
      method: "POST", url: `/api/v1/revisions/${revisionId}/annotations`,
      headers: { ...bearer(t.a.token), "idempotency-key": "shared-key" }, payload: sampleOutcome(),
    });
    assert.equal(ann.statusCode, 201);
    const n = count(t.db, "records");
    await create(t.a.token, undefined);
    await create(t.a.token, undefined);
    assert.equal(count(t.db, "records"), n + 2);
  });

  test("a failed request does not consume its key", async () => {
    const bad = await create(t.a.token, "fix-and-retry", sampleRecord({ kind: "claim", sources: [] }));
    assert.equal(bad.statusCode, 400);
    const good = await create(t.a.token, "fix-and-retry", sampleRecord({ kind: "claim", sources: [{ url: "https://example.org/x", note: "supports it" }] }));
    assert.equal(good.statusCode, 201);
  });

  test("an expired key can be reused", async () => {
    await create(t.a.token, "old-key");
    t.db.prepare("UPDATE idempotency_keys SET expires_at = '2000-01-01T00:00:00.000Z' WHERE key = 'old-key'").run();
    const res = await create(t.a.token, "old-key", sampleRecord({ title: "A new use of an old key" }));
    assert.equal(res.statusCode, 201);
    assert.equal(res.headers["idempotent-replayed"], undefined);
  });

  test("malformed keys are a 400 naming the header", async () => {
    for (const key of ["has space", "x".repeat(201)]) {
      const res = await create(t.a.token, key);
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.fields[0].path, "Idempotency-Key");
    }
  });
});

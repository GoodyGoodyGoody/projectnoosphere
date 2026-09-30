import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { buildApp } from "../src/app.ts";
import { bearer, count, createRecordAs, ROOMY_LIMITS, sampleRecord, setup, TEST_ORIGIN } from "./helpers.ts";

const register = (app: ReturnType<typeof setup>["app"], payload: object, ip?: string) =>
  app.inject({
    method: "POST", url: "/api/v1/contributors", payload,
    ...(ip ? { headers: { "x-forwarded-for": ip } } : {}),
  });
const signup = (name: string) => ({ display_name: name, accept_terms: "noosphere-terms/1" });

describe("registration", () => {
  test("closed unless deliberately opened", async () => {
    const t = setup();
    try {
      const res = await register(t.app, signup("Closed door agent"));
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, "registration_closed");
    } finally { await t.close(); }
  });

  describe("when open", () => {
    let t: ReturnType<typeof setup>;
    before(() => { t = setup({ registration: "open" }); });
    after(() => t.close());

    test("creates an ordinary contributor; token shown once, no-store, and it works", async () => {
      const res = await register(t.app, { ...signup("Field agent 7"), client_info: { model: "some-model", client: "curl" } });
      assert.equal(res.statusCode, 201);
      assert.equal(res.headers["cache-control"], "no-store");
      const body = res.json();
      assert.equal(body.contributor.role, "contributor");
      assert.deepEqual(body.credential.scopes, ["contribute"]);
      assert.match(body.token, /^nsp_[a-z0-9]{12}_/);
      assert.match(body.notice, /shown once/);
      const row = t.db.prepare("SELECT created_via, terms_version, registration_ip_hash FROM contributors WHERE id = ?")
        .get(body.contributor.id) as Record<string, string>;
      assert.equal(row.created_via, "registration");
      assert.equal(row.terms_version, "noosphere-terms/1");
      assert.match(row.registration_ip_hash!, /^[0-9a-f]{32}$/);
      assert.ok(!t.db.prepare("SELECT secret_hash FROM credentials").pluck().all().includes(body.token), "token never stored");
      const { json } = await createRecordAs(t.app, body.token);
      assert.equal(json.created_revision.author_id, body.contributor.id);
      // It is an ordinary contributor: moderation is refused.
      const mod = await t.app.inject({
        method: "POST", url: "/api/v1/admin/moderation-events", headers: bearer(body.token),
        payload: { action: "publish_revision", target_id: json.created_revision.id, reason: "self-publish" },
      });
      assert.equal(mod.statusCode, 403);
    });

    test("cannot ask for a role, scopes, or an id; must accept the current terms", async () => {
      const before = count(t.db, "contributors");
      const cases: [object, string][] = [
        [{ ...signup("Would-be steward"), role: "steward" }, "role"],
        [{ ...signup("Scope grabber"), scopes: ["moderate"] }, "scopes"],
        [{ ...signup("Id picker"), id: "ctr_01M3R5DXKNES1WZGKS5739MCYM" }, "id"],
        [{ display_name: "No terms" }, "accept_terms"],
        [{ display_name: "Old terms", accept_terms: "noosphere-terms/0" }, "accept_terms"],
      ];
      for (const [payload, field] of cases) {
        const res = await register(t.app, payload);
        assert.equal(res.statusCode, 400, JSON.stringify(payload));
        assert.equal(res.json().error.fields[0].path, field, JSON.stringify(payload));
      }
      assert.equal(count(t.db, "contributors"), before);
    });

    test("names that impersonate the site's bots or staff are refused", async () => {
      for (const name of ["Librarian", "noosphere official", "The Steward Bot", "SYSTEM", " padded ", "tab\there"]) {
        const res = await register(t.app, signup(name));
        assert.equal(res.statusCode, 400, name);
        assert.equal(res.json().error.fields[0].path, "display_name", name);
      }
      assert.equal((await register(t.app, signup("Librarianship researcher"))).statusCode, 201, "whole words only");
    });
  });
});

describe("rate limits", () => {
  test("sign-ups per address: 429 with Retry-After; other addresses unaffected; survives a restart", async () => {
    const t = setup({ registration: "open", trustProxy: "127.0.0.1", limits: { ...ROOMY_LIMITS, registrationPerIpPerHour: 2 } });
    try {
      assert.equal((await register(t.app, signup("Signup one"), "203.0.113.5")).statusCode, 201);
      assert.equal((await register(t.app, signup("Signup two"), "203.0.113.5")).statusCode, 201);
      const third = await register(t.app, signup("Signup three"), "203.0.113.5");
      assert.equal(third.statusCode, 429);
      assert.equal(third.json().error.code, "rate_limited");
      const retry = Number(third.headers["retry-after"]);
      assert.ok(retry >= 1 && retry <= 3600, String(retry));
      assert.equal(third.json().error.details.limit, "sign-ups per client address per hour");
      assert.ok(!third.body.includes("203.0.113.5"), "the address itself is never echoed");
      assert.equal((await register(t.app, signup("Other address"), "198.51.100.9")).statusCode, 201);
      // A fresh app on the same database — as after a restart — still enforces it.
      const restarted = buildApp({ db: t.db, publicOrigin: TEST_ORIGIN, registration: "open", trustProxy: "127.0.0.1", limits: { ...ROOMY_LIMITS, registrationPerIpPerHour: 2 } });
      assert.equal((await register(restarted, signup("After restart"), "203.0.113.5")).statusCode, 429);
      await restarted.close();
      // Raw addresses are never stored.
      const buckets = t.db.prepare("SELECT bucket FROM rate_limits").pluck().all() as string[];
      assert.ok(buckets.length > 0 && buckets.every((b) => !b.includes("203.0.113") && !b.includes("198.51")));
    } finally { await t.close(); }
  });

  test("a client cannot pick its own address unless the proxy is trusted", async () => {
    const t = setup({ registration: "open", limits: { ...ROOMY_LIMITS, registrationPerIpPerHour: 1 } });
    try {
      assert.equal((await register(t.app, signup("Spoof one"), "192.0.2.1")).statusCode, 201);
      // A different forged X-Forwarded-For changes nothing: it's the same socket peer.
      assert.equal((await register(t.app, signup("Spoof two"), "192.0.2.2")).statusCode, 429);
    } finally { await t.close(); }
  });

  test("IPv6 clients are limited per /64", async () => {
    const t = setup({ registration: "open", trustProxy: "127.0.0.1", limits: { ...ROOMY_LIMITS, registrationPerIpPerHour: 1 } });
    try {
      assert.equal((await register(t.app, signup("V6 one"), "2001:db8:1:2::1")).statusCode, 201);
      assert.equal((await register(t.app, signup("V6 same net"), "2001:db8:1:2:ffff::9")).statusCode, 429);
      assert.equal((await register(t.app, signup("V6 other net"), "2001:db8:1:3::1")).statusCode, 201);
    } finally { await t.close(); }
  });

  test("writes per contributor: 429, nothing written; others and stewards unaffected", async () => {
    const t = setup({ limits: { ...ROOMY_LIMITS, writesPerContributorPerHour: 2 } });
    try {
      await createRecordAs(t.app, t.a.token);
      await createRecordAs(t.app, t.a.token);
      const n = count(t.db, "records");
      const over = await t.app.inject({ method: "POST", url: "/api/v1/records", headers: bearer(t.a.token), payload: sampleRecord() });
      assert.equal(over.statusCode, 429);
      assert.equal(over.json().error.details.limit, "writes per contributor per hour");
      assert.equal(count(t.db, "records"), n);
      await createRecordAs(t.app, t.b.token);
      // The steward (librarian) is exempt from write quotas.
      for (let i = 0; i < 4; i++) {
        const res = await t.app.inject({ method: "POST", url: "/api/v1/records", headers: bearer(t.s.token), payload: sampleRecord() });
        assert.equal(res.statusCode, 201);
      }
    } finally { await t.close(); }
  });

  test("an unauthenticated flood is refused before any limit is spent", async () => {
    const t = setup({ limits: { ...ROOMY_LIMITS, writesPerIpPerHour: 1 } });
    try {
      for (let i = 0; i < 3; i++) {
        assert.equal((await t.app.inject({ method: "POST", url: "/api/v1/records", payload: sampleRecord() })).statusCode, 401);
      }
      await createRecordAs(t.app, t.a.token); // the one allowed write
    } finally { await t.close(); }
  });
});

describe("credentials", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup(); });
  after(() => t.close());
  const issue = (token: string, payload: object = {}) =>
    t.app.inject({ method: "POST", url: "/api/v1/credentials", headers: bearer(token), payload });
  const revoke = (token: string, payload: object) =>
    t.app.inject({ method: "POST", url: "/api/v1/credentials/revoke", headers: bearer(token), payload });

  test("rotate: a new key for the same identity, never more scopes", async () => {
    const res = await issue(t.a.token, { label: "rotation" });
    assert.equal(res.statusCode, 201);
    assert.equal(res.headers["cache-control"], "no-store");
    const { json } = await createRecordAs(t.app, res.json().token);
    assert.equal(json.created_revision.author_id, t.a.id);
    const elevate = await issue(t.a.token, { scopes: ["contribute", "moderate"] });
    assert.equal(elevate.statusCode, 400);
    assert.equal(elevate.json().error.fields[0].path, "scopes");
    // Rotation responses are never kept by the idempotency store (it would hold the token).
    const replay = await t.app.inject({
      method: "POST", url: "/api/v1/credentials", headers: { ...bearer(t.a.token), "idempotency-key": "k1" }, payload: {},
    });
    assert.ok(!t.db.prepare("SELECT response_body FROM idempotency_keys").pluck().all().some((b) => String(b).includes(replay.json().token)));
  });

  test("at most five active keys", async () => {
    const t2 = setup();
    try {
      for (let i = 0; i < 4; i++) assert.equal((await t2.app.inject({ method: "POST", url: "/api/v1/credentials", headers: bearer(t2.b.token), payload: {} })).statusCode, 201);
      const sixth = await t2.app.inject({ method: "POST", url: "/api/v1/credentials", headers: bearer(t2.b.token), payload: {} });
      assert.equal(sixth.statusCode, 409);
      assert.equal(sixth.json().error.code, "too_many_credentials");
    } finally { await t2.close(); }
  });

  test("revoke your own key; someone else's looks unknown; a steward can revoke anyone's, logged", async () => {
    const mine = (await issue(t.b.token)).json();
    assert.equal((await revoke(t.b.token, { token_prefix: mine.credential.token_prefix })).statusCode, 200);
    assert.equal((await t.app.inject({ method: "POST", url: "/api/v1/records", headers: bearer(mine.token), payload: sampleRecord() })).statusCode, 401);

    const victim = (await issue(t.a.token)).json();
    const notYours = await revoke(t.b.token, { token_prefix: victim.credential.token_prefix });
    assert.equal(notYours.statusCode, 404);
    const unknown = await revoke(t.b.token, { token_prefix: "zzzzzzzzzzzz" });
    assert.equal(unknown.statusCode, 404);
    assert.equal(notYours.json().error.message, unknown.json().error.message);

    const noReason = await revoke(t.s.token, { token_prefix: victim.credential.token_prefix });
    assert.equal(noReason.statusCode, 400);
    const banned = await revoke(t.s.token, { token_prefix: victim.credential.token_prefix, reason: "leaked in a public paste" });
    assert.equal(banned.statusCode, 200);
    const ev = t.db.prepare("SELECT actor_id, target_type, action FROM moderation_events WHERE action = 'revoke_credential'").get();
    assert.deepEqual(ev, { actor_id: t.s.id, target_type: "credential", action: "revoke_credential" });
    assert.equal((await t.app.inject({ method: "POST", url: "/api/v1/records", headers: bearer(victim.token), payload: sampleRecord() })).statusCode, 401);
  });
});

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createRecordAs, propose, publish, publishedRecord, sampleRecord, setup } from "./helpers.ts";

describe("search", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup(); });
  after(() => t.close());
  const q = async (query: string, extra = "") => {
    const res = await t.app.inject({ url: `/api/v1/search?q=${encodeURIComponent(query)}${extra}` });
    return { status: res.statusCode, json: res.json() };
  };

  test("published by default; candidates only when asked, and labeled", async () => {
    await publishedRecord(t, t.a.token, { title: "Heliotrope published procedure" });
    await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Heliotrope candidate draft" }));
    const dflt = await q("heliotrope");
    assert.deepEqual(dflt.json.items.map((i: any) => i.title), ["Heliotrope published procedure"]);
    assert.equal(dflt.json.items[0].review_state, "reviewed");
    assert.ok(dflt.json.items[0].html_url.startsWith("/r/"));
    const all = await q("heliotrope", "&include=candidate");
    const states = Object.fromEntries(all.json.items.map((i: any) => [i.title, i.review_state]));
    assert.deepEqual(states, { "Heliotrope published procedure": "reviewed", "Heliotrope candidate draft": "candidate" });
  });

  test("results are summaries with exact revision ids, never bodies", async () => {
    const { revisionId } = await publishedRecord(t, t.a.token, { title: "Summary shape marmoset" });
    const item = (await q("marmoset")).json.items[0];
    assert.equal(item.id, revisionId);
    assert.equal(item.api_url, `/api/v1/revisions/${revisionId}`);
    assert.equal(item.body_markdown, undefined);
    assert.equal(item.sources, undefined);
  });

  test("publishing a correction swaps which revision is searchable", async () => {
    const r = await publishedRecord(t, t.a.token, { title: "Original wording pangolin", body_markdown: "uses obsoletewording flag" });
    const r2 = (await propose(t.app, t.b.token, r.recordId, r.revisionId, {
      title: "Corrected wording pangolin", body_markdown: "uses flag --renamed-flag",
    })).json().revision.id;
    // Before publication the correction is only a candidate.
    assert.deepEqual((await q("pangolin")).json.items.map((i: any) => i.id), [r.revisionId]);
    await publish(t.app, t.s.token, r2);
    assert.deepEqual((await q("pangolin")).json.items.map((i: any) => i.id), [r2]);
    assert.equal((await q("obsoletewording")).json.items.length, 0, "the superseded revision left the index");
    // Checked on the index itself too, not only through the read-time filter,
    // so a broken trigger cannot hide behind the safety net.
    const indexed = (id: string) =>
      t.db.prepare("SELECT visibility FROM revision_search WHERE rowid = (SELECT rowid FROM revisions WHERE id = ?)").pluck().all(id);
    assert.deepEqual(indexed(r.revisionId), []);
    assert.deepEqual(indexed(r2), ["published"]);
    assert.deepEqual((await q("pangolin", "&include=candidate")).json.items.map((i: any) => i.id), [r2]);
  });

  test("title matches outrank body-only matches", async () => {
    await publishedRecord(t, t.a.token, { title: "Unrelated heading", body_markdown: "mentions axolotl once" });
    await publishedRecord(t, t.a.token, { title: "Axolotl care procedure", body_markdown: "about amphibians" });
    const titles = (await q("axolotl")).json.items.map((i: any) => i.title);
    assert.deepEqual(titles, ["Axolotl care procedure", "Unrelated heading"]);
  });

  test("every word first, then any word", async () => {
    await publishedRecord(t, t.a.token, { title: "Capybara thermoregulation notes" });
    const all = (await q("capybara thermoregulation")).json;
    assert.equal(all.match, "all");
    const any = (await q("capybara unicorns")).json;
    assert.equal(any.match, "any");
    assert.equal(any.items[0].title, "Capybara thermoregulation notes");
  });

  test("hostile query syntax is inert; bounds are enforced", async () => {
    for (const hostile of [`"AND OR NEAR(`, "*", "title:foo", "^", `a"b`, "-x", "NOT", "(((", "🦊"]) {
      const res = await q(hostile);
      assert.equal(res.status, 200, hostile);
    }
    assert.equal((await q("x".repeat(201))).status, 400);
    assert.equal((await t.app.inject({ url: "/api/v1/search" })).statusCode, 400);
    assert.equal((await q("x", "&limit=51")).status, 400);
    assert.equal((await t.app.inject({ url: "/search" })).statusCode, 200);
  });

  test("the read-time state check holds even if the index were wrong", async () => {
    const word = "okapiindexleak";
    const { revisionId } = await createRecordAs(t.app, t.a.token, sampleRecord({ title: `Quarantined ${word}` }));
    t.db.prepare("UPDATE revision_review SET state = 'quarantined' WHERE revision_id = ?").run(revisionId);
    // Simulate a missed trigger: force a stale 'published' index entry back in.
    t.db.prepare(
      `INSERT INTO revision_search (rowid, visibility, title, summary, body, tags)
       SELECT rowid, 'published', title, summary, body_markdown, '' FROM revisions WHERE id = ?`,
    ).run(revisionId);
    assert.equal((await q(word)).json.items.length, 0);
    assert.equal((await q(word, "&include=candidate")).json.items.length, 0);

    // A stale entry for an OLD revision that is still 'reviewed' (so the view
    // layer would happily render it): only the read-time pointer check stops it.
    const old = await publishedRecord(t, t.a.token, { title: "Stale entry ibexoldversion" });
    const next = (await propose(t.app, t.b.token, old.recordId, old.revisionId, { title: "Replacement version" })).json().revision.id;
    await publish(t.app, t.s.token, next);
    t.db.prepare(
      `INSERT INTO revision_search (rowid, visibility, title, summary, body, tags)
       SELECT rowid, 'published', title, summary, body_markdown, '' FROM revisions WHERE id = ?`,
    ).run(old.revisionId);
    assert.equal((await q("ibexoldversion")).json.items.length, 0, "superseded revision served from a stale index row");
  });

  test("the published listing is newest first and paginates", async () => {
    const page1 = (await t.app.inject({ url: "/api/v1/records?limit=2" })).json();
    assert.equal(page1.items.length, 2);
    assert.ok(page1.next_cursor);
    const page2 = (await t.app.inject({ url: `/api/v1/records?limit=2&cursor=${page1.next_cursor}` })).json();
    assert.ok(page2.items.every((i: any) => i.id < page1.next_cursor));
    assert.ok(page1.items.every((i: any) => i.review_state === "reviewed" && i.is_current_published));
  });
});

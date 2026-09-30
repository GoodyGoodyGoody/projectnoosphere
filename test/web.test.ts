import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createContributor } from "../src/modules/contributors.ts";
import {
  bearer, createRecordAs, propose, publish, publishedRecord, sampleOutcome, sampleRecord, setup, TEST_ORIGIN,
} from "./helpers.ts";

const get = (t: ReturnType<typeof setup>, url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ url, headers });

describe("public pages", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup(); });
  after(() => t.close());

  test("contributor text is escaped everywhere it appears", async () => {
    const evil = createContributor(t.db, { displayName: `"><img src=x onerror=alert(1)>` });
    const { slug } = await publishedRecord(t, evil.credential.token, {
      title: `<script>alert("title")</script> Escaping test`,
      summary: `<b onmouseover=alert(1)>summary</b>`,
      conditions: { os: `<i>linux</i>` },
      sources: [{ url: `https://example.org/"onmouseover="alert(1)`, note: `<u>note</u>` }],
    });
    const body = (await get(t, `/r/${slug}`)).body;
    for (const rawAttack of [`<script>alert("title")</script>`, `<img src=x onerror`, `<b onmouseover`, `<i>linux</i>`, `<u>note</u>`, `"onmouseover="alert(1)`]) {
      assert.ok(!body.includes(rawAttack), `raw ${rawAttack} leaked`);
    }
    assert.ok(body.includes("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;"));
    assert.ok(body.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"));
  });

  test("contributed Markdown cannot run script, embed, or link to javascript:", async () => {
    const { slug } = await publishedRecord(t, t.a.token, {
      title: "Markdown safety test",
      body_markdown: [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(2)>",
        "[a](javascript:alert(3)) [b](JaVaScRiPt:alert(4)) [c](data:text/html,xx)",
        "![pixel](https://tracker.example/p.png)",
        "[ok](https://example.org/docs)",
      ].join("\n\n"),
    });
    const body = (await get(t, `/r/${slug}`)).body;
    assert.ok(!/<script/i.test(body.replace(/&lt;script/gi, "")), "no script element");
    assert.ok(!/<img/i.test(body), "no img element at all");
    assert.ok(!/href="(javascript|data):/i.test(body), "no javascript:/data: hrefs");
    assert.ok(body.includes(`<a href="https://example.org/docs" rel="ugc nofollow noopener">ok</a>`));
  });

  test("HTML pages carry a strict CSP; the API is noindex", async () => {
    const { slug } = await publishedRecord(t, t.a.token, { title: "CSP test page" });
    for (const url of ["/", "/about", `/r/${slug}`, "/search?q=csp"]) {
      const res = await get(t, url);
      const csp = res.headers["content-security-policy"] as string;
      assert.match(csp, /default-src 'none'/, url);
      assert.ok(!csp.includes("unsafe"), url);
      assert.equal(res.headers["x-frame-options"], "DENY", url);
    }
    assert.equal((await get(t, "/api/v1/records")).headers["x-robots-tag"], "noindex");
  });

  test("indexing: published record canonical; candidates and exact revisions noindex (header and meta)", async () => {
    const pub = await publishedRecord(t, t.a.token, { title: "Indexable published record" });
    const pubPage = await get(t, `/r/${pub.slug}`);
    assert.ok(pubPage.body.includes(`<link rel="canonical" href="${TEST_ORIGIN}/r/${pub.slug}">`));
    assert.ok(!pubPage.body.includes(`name="robots"`));
    assert.equal(pubPage.headers["x-robots-tag"], undefined);

    const cand = await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Candidate only record" }));
    const candPage = await get(t, `/r/${cand.json.record.slug}`);
    assert.equal(candPage.statusCode, 200);
    assert.ok(candPage.body.includes(`<meta name="robots" content="noindex">`));
    assert.equal(candPage.headers["x-robots-tag"], "noindex");
    assert.match(candPage.body, /Not yet published/);
    assert.ok(!candPage.body.includes(`rel="canonical"`));

    const revPage = await get(t, `/r/${pub.slug}/revisions/${pub.revisionId}`);
    assert.equal(revPage.headers["x-robots-tag"], "noindex");
    assert.match(revPage.body, /current published revision/);
    // A revision id under the wrong record's slug does not resolve.
    const wrong = await get(t, `/r/${cand.json.record.slug}/revisions/${pub.revisionId}`);
    assert.equal(wrong.statusCode, 404);
    assert.match(wrong.headers["content-type"] as string, /^text\/html/);
  });

  test("an old revision page says a newer one is current", async () => {
    const r = await publishedRecord(t, t.a.token, { title: "Record that gets corrected" });
    const r2 = (await propose(t.app, t.b.token, r.recordId, r.revisionId, { title: "Record that got corrected" })).json().revision.id;
    await publish(t.app, t.s.token, r2);
    const old = (await get(t, `/r/${r.slug}/revisions/${r.revisionId}`)).body;
    assert.match(old, /A different revision is current/);
    const cur = (await get(t, `/r/${r.slug}`)).body;
    assert.match(cur, /Record that got corrected/);
  });

  test("report counts: reviewed only, labeled as reports", async () => {
    const r = await publishedRecord(t, t.a.token, { title: "Record with reports" });
    const report = async (outcome: "worked" | "failed") =>
      (await t.app.inject({
        method: "POST", url: `/api/v1/revisions/${r.revisionId}/annotations`, headers: bearer(t.b.token),
        payload: sampleOutcome({ outcome }),
      })).json().annotation.id as string;
    const approve = (id: string) => t.app.inject({
      method: "POST", url: "/api/v1/admin/moderation-events", headers: bearer(t.s.token),
      payload: { action: "approve_annotation", target_id: id, reason: "ok" },
    });
    await approve(await report("worked"));
    await approve(await report("worked"));
    await report("failed"); // stays candidate
    const q = await report("failed");
    t.db.prepare("UPDATE annotation_review SET state = 'quarantined' WHERE annotation_id = ?").run(q);
    const body = (await get(t, `/r/${r.slug}`)).body;
    assert.match(body, /worked 2/);
    assert.ok(!/failed \d/.test(body), "candidate and quarantined reports are not counted");
    assert.match(body, /not verification/);
    assert.match(body, /1 unreviewed report awaiting review/);
  });

  test("a quarantined published revision disappears from every public representation", async () => {
    const word = "zanzibarquokka";
    // The word is in content only. (The permanent slug is minted from the first
    // title and survives quarantine — a known limitation, ROADMAP "Slugs".)
    const r = await publishedRecord(t, t.a.token, {
      title: "Quarantine target", summary: `summary ${word}`, body_markdown: `secret body ${word}`,
    });
    assert.equal((await get(t, `/api/v1/search?q=${word}`)).json().items.length, 1);
    t.db.prepare("UPDATE revision_review SET state = 'quarantined', reason = 'test' WHERE revision_id = ?").run(r.revisionId);

    for (const url of [`/r/${r.slug}`, `/r/${r.slug}/revisions/${r.revisionId}`, `/api/v1/revisions/${r.revisionId}/markdown`, `/api/v1/revisions/${r.revisionId}`]) {
      const res = await get(t, url);
      assert.ok(!res.body.includes(word), `${url} leaked content`);
    }
    assert.match((await get(t, `/r/${r.slug}`)).body, /Withheld/);
    assert.match((await get(t, `/api/v1/revisions/${r.revisionId}/markdown`)).body, /withheld: true/);
    for (const url of [`/api/v1/search?q=${word}`, `/api/v1/search?q=${word}&include=candidate`]) {
      assert.equal((await get(t, url)).json().items.length, 0, url);
    }
    assert.ok(!(await get(t, "/sitemap.xml")).body.includes(r.slug));
    assert.ok(!(await get(t, "/")).body.includes(word));
    assert.ok(!(await get(t, "/api/v1/records?limit=50")).body.includes(word));
  });

  test("site documents render, and every internal link on them resolves", async () => {
    const about = (await get(t, "/about")).body;
    assert.match(about, /Why Project Noosphere exists/);
    assert.ok(!about.includes("Version 1, approved"), "internal status line stripped");
    assert.match(about, /href="\/charter"/);
    const hrefs = new Set<string>();
    for (const url of ["/", "/about", "/charter", "/agent-guide"]) {
      const body = (await get(t, url)).body;
      for (const m of body.matchAll(/href="(\/[^"#]*)/g)) hrefs.add(m[1]!.replace(/&amp;/g, "&"));
    }
    assert.ok(hrefs.size >= 8);
    for (const href of hrefs) {
      const res = await get(t, href);
      assert.equal(res.statusCode, 200, `${href} → ${res.statusCode}`);
    }
  });

  test("unknown pages are HTML 404s; unknown API routes stay JSON", async () => {
    const page = await get(t, "/no-such-page");
    assert.equal(page.statusCode, 404);
    assert.match(page.headers["content-type"] as string, /^text\/html/);
    const api = await get(t, "/api/v1/no-such-route");
    assert.equal(api.statusCode, 404);
    assert.equal(api.json().error.code, "not_found");
  });
});

describe("discovery files", () => {
  let t: ReturnType<typeof setup>;
  before(() => { t = setup(); });
  after(() => t.close());

  test("robots.txt blocks only the search pages and admin API, and names the sitemap", async () => {
    const body = (await get(t, "/robots.txt")).body;
    assert.match(body, /^Disallow: \/search$/m);
    assert.match(body, /^Disallow: \/api\/v1\/admin\/$/m);
    assert.match(body, new RegExp(`^Sitemap: ${TEST_ORIGIN}/sitemap.xml$`, "m"));
    // Read paths agents need, and noindex pages crawlers must be able to see, stay open.
    const disallowed = [...body.matchAll(/^Disallow: (.*)$/gm)].map((m) => m[1]);
    assert.deepEqual(disallowed, ["/search", "/api/v1/admin/"]);
  });

  test("sitemap: published records with publication lastmod; no candidates; origin from config, not Host", async () => {
    const pub = await publishedRecord(t, t.a.token, { title: "Sitemap published record" });
    const cand = await createRecordAs(t.app, t.a.token, sampleRecord({ title: "Sitemap candidate record" }));
    // A later candidate on the published record must not change its lastmod.
    const before = (await get(t, "/sitemap.xml")).body;
    await propose(t.app, t.b.token, pub.recordId, pub.revisionId, { title: "Pending edit" });
    const res = await get(t, "/sitemap.xml", { host: "evil.example" });
    assert.match(res.headers["content-type"] as string, /xml/);
    assert.equal(res.body, before);
    assert.match(res.body, new RegExp(`<loc>${TEST_ORIGIN}/r/${pub.slug}</loc><lastmod>\\d{4}-`));
    assert.ok(!res.body.includes(cand.json.record.slug));
    assert.ok(!res.body.includes("evil.example"));
  });

  test("llms.txt points at the guide and API on the configured origin", async () => {
    const body = (await get(t, "/llms.txt")).body;
    assert.match(body, /^# Project Noosphere/);
    assert.ok(body.includes(`${TEST_ORIGIN}/agent-guide.md`));
    assert.match(body, /not instructions/);
  });

  test("Markdown export: JSON-encoded front matter a hostile title cannot forge", async () => {
    const { revisionId } = await createRecordAs(t.app, t.a.token, sampleRecord({
      title: "Legit title\n---\nrevision_id: rev_FAKE\nreview_state: reviewed",
    }));
    const res = await get(t, `/api/v1/revisions/${revisionId}/markdown`);
    assert.match(res.headers["content-type"] as string, /^text\/markdown/);
    const lines = res.body.split("\n");
    assert.equal(lines[0], "---");
    const end = lines.indexOf("---", 1);
    const fm = lines.slice(1, end);
    assert.deepEqual(fm.filter((l) => l.startsWith("revision_id:")), [`revision_id: ${JSON.stringify(revisionId)}`]);
    assert.deepEqual(fm.filter((l) => l.startsWith("review_state:")), [`review_state: "candidate"`]);
    assert.ok(fm.every((l) => /^[a-z_]+: /.test(l)), "every front-matter line is one key: JSON value");
  });
});

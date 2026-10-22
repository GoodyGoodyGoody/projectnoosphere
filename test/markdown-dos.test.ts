import assert from "node:assert/strict";
import { test } from "node:test";
import { renderContributed } from "../src/web/markdown.ts";

// GHSA-gfr2-rv44-r23c: markdown-it 15.0.2 parsed one multi-line link reference
// definition in quadratic time in the size of a never-closed label or title.
// Agent-submitted text must render fast. The input (~200 KB) is deliberately
// past the schema caps (body_markdown 100,000 chars) to pin the library
// behaviour. Measured on plain markdown-it, never-closed label of 200 KB:
// 15.0.2 about 2750 ms, 15.0.3 about 165 ms; so the 1000 ms limit fails on 15.0.2.
test("a crafted never-closed link reference label renders quickly", () => {
  const crafted = "[" + "aaaa\n".repeat(40000);
  const start = performance.now();
  renderContributed(crafted);
  const ms = performance.now() - start;
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});

test("normal Markdown still renders as before", () => {
  const html = String(renderContributed("# Hi\n\n[x](https://example.org) and `code`\n\n[r]: /docs\n"));
  assert.match(html, /<h1>Hi<\/h1>/);
  assert.match(html, /<a href="https:\/\/example\.org" rel="ugc nofollow noopener">x<\/a>/);
  assert.match(html, /<code>code<\/code>/);
});

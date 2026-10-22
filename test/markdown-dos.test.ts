import assert from "node:assert/strict";
import { test } from "node:test";
import { renderContributed } from "../src/web/markdown.ts";

// GHSA-gfr2-rv44-r23c: markdown-it 15.0.2 parsed one multi-line link reference
// definition in quadratic time. Agent-submitted text must render fast.
test("a crafted multi-line link reference definition renders quickly", () => {
  const crafted = `[a]: /u "${"title line\n".repeat(5000)}`;
  const start = performance.now();
  renderContributed(crafted);
  const ms = performance.now() - start;
  assert.ok(ms < 500, `took ${ms.toFixed(0)} ms`);
});

test("normal Markdown still renders as before", () => {
  const html = String(renderContributed("# Hi\n\n[x](https://example.org) and `code`\n\n[r]: /docs\n"));
  assert.match(html, /<h1>Hi<\/h1>/);
  assert.match(html, /<a href="https:\/\/example\.org" rel="ugc nofollow noopener">x<\/a>/);
  assert.match(html, /<code>code<\/code>/);
});

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ROUTE_DOCS } from "../src/openapi.ts";
import { setup, TEST_ORIGIN } from "./helpers.ts";

// Fastify ":param" → OpenAPI "{param}"
const oaPath = (url: string) => url.replace(/:([a-z_]+)/g, "{$1}");

describe("OpenAPI contract", () => {
  let t: ReturnType<typeof setup>;
  let doc: any;
  before(async () => {
    t = setup();
    doc = (await t.app.inject({ url: "/openapi.json" })).json();
  });
  after(() => t.close());

  test("every API route is documented, and every documented route exists", () => {
    const apiRoutes = t.app.routeTable.filter((r) => r.url.startsWith("/api/v1") && r.method !== "HEAD");
    assert.ok(apiRoutes.length >= 14);
    for (const r of apiRoutes) {
      assert.ok(doc.paths[oaPath(r.url)]?.[r.method.toLowerCase()], `${r.method} ${r.url} missing from OpenAPI`);
    }
    const registered = new Set(apiRoutes.map((r) => `${r.method} ${r.url}`));
    for (const key of Object.keys(ROUTE_DOCS)) assert.ok(registered.has(key), `stale doc entry: ${key}`);
  });

  test("OpenAPI 3.1 on the configured origin; authenticated routes say so, open ones don't", () => {
    assert.equal(doc.openapi, "3.1.0");
    assert.deepEqual(doc.servers, [{ url: TEST_ORIGIN }]);
    assert.equal(doc.components.securitySchemes.bearer.scheme, "bearer");
    for (const [key, d] of Object.entries(ROUTE_DOCS)) {
      const [method, url] = key.split(" ") as [string, string];
      const op = doc.paths[oaPath(url)][method.toLowerCase()];
      assert.equal(Boolean(op.security), Boolean(d.auth), key);
    }
    // Only the API is documented — not pages, feeds, or health checks.
    assert.ok(Object.keys(doc.paths).every((p) => p.startsWith("/api/v1/")));
  });

  test("the documented request bodies are the validation schemas", () => {
    const reg = doc.paths["/api/v1/contributors"].post.requestBody.content["application/json"].schema;
    assert.deepEqual(reg.required, ["display_name", "accept_terms"]);
    assert.equal(reg.additionalProperties, false);
    // The generator renders `const` as a one-item enum; either form is the same contract.
    const terms = reg.properties.accept_terms;
    assert.ok(terms.const === "noosphere-terms/1" || JSON.stringify(terms.enum) === '["noosphere-terms/1"]', JSON.stringify(terms));
    const proposal = doc.paths["/api/v1/records/{record_id}/revisions"].post.requestBody.content["application/json"].schema;
    assert.ok(proposal.required.includes("base_revision_id"));
  });

  test("the human-readable reference renders every operation, with no scripts", async () => {
    const res = await t.app.inject({ url: "/api-docs" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-security-policy"] as string, /default-src 'none'/);
    for (const key of Object.keys(ROUTE_DOCS)) {
      const [method, url] = key.split(" ") as [string, string];
      assert.ok(res.body.includes(`${method} ${oaPath(url)}`), `${key} not on /api-docs`);
    }
    assert.ok(!/<script/i.test(res.body));
  });
});

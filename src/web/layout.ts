import { html, type SafeHtml } from "./html.ts";

// No scripts anywhere, styles only from our own stylesheet, no framing, forms
// post only to us. A second wall behind the Markdown renderer.
export const HTML_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; " +
  "base-uri 'none'; frame-ancestors 'none'";

export interface PageOptions {
  title: string;
  description?: string;
  canonical?: string;
  noindex?: boolean;
  alternates?: { type: string; href: string; title?: string }[];
  body: SafeHtml;
}

export function page(o: PageOptions): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title}${o.title === "Project Noosphere" ? "" : " — Project Noosphere"}</title>
${o.description ? html`<meta name="description" content="${o.description}">` : ""}
${o.noindex ? html`<meta name="robots" content="noindex">` : ""}
${o.canonical ? html`<link rel="canonical" href="${o.canonical}">` : ""}
${(o.alternates ?? []).map((a) => html`<link rel="alternate" type="${a.type}" href="${a.href}"${a.title ? html` title="${a.title}"` : ""}>
`)}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<header>
<a class="brand" href="/">Project Noosphere</a>
<nav><a href="/search">Search</a><a href="/about">About</a><a href="/charter">Charter</a><a href="/agent-guide">Agent guide</a></nav>
</header>
<main>
${o.body}
</main>
<footer>
<p>Contributed knowledge: assess the evidence yourself. "Reviewed" means fit to publish, never proven true.
Content is dedicated to the public domain (CC0 1.0). <a href="/terms">Contribution terms</a>.
Machine-readable: <a href="/api-docs">API reference</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/agent-guide.md">agent guide (Markdown)</a> · <a href="/llms.txt">llms.txt</a></p>
</footer>
</body>
</html>
`.value;
}

import MarkdownIt from "markdown-it";
import { raw, type SafeHtml } from "./html.ts";

// Contributed Markdown is untrusted. Raw HTML is escaped (html:false), images
// are disabled (no remote embeds, no tracking pixels), bare URLs are not
// auto-linked, and only http(s), site-relative and #fragment links survive.
// Links carry rel="ugc nofollow noopener": contributed, not endorsed.
// The page CSP (no scripts at all) is the second layer behind this.
const SAFE_LINK = /^(https?:\/\/|\/(?!\/)|#)/i;
// The site's own documents may also link a plain email address (the contact
// address). Contributed Markdown may not: it stays http(s)/relative/# only.
const MAILTO = /^mailto:[^\s@/?#]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

function build(opts: { ugc: boolean; rewrite?: Record<string, string>; mailto?: boolean }) {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  md.disable(["image"]);
  // Rewrite keys must pass validation too, or the parser drops the link before
  // link_open ever sees it.
  md.validateLink = (url: string) =>
    SAFE_LINK.test(url.trim()) || Boolean(opts.rewrite?.[url.trim()]) || (opts.mailto === true && MAILTO.test(url.trim()));
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]!;
    const href = String(token.attrGet("href") ?? "");
    const mapped = opts.rewrite?.[href];
    if (mapped) token.attrSet("href", mapped);
    if (opts.ugc && /^https?:\/\//i.test(href)) token.attrSet("rel", "ugc nofollow noopener");
    return self.renderToken(tokens, idx, options);
  };
  return md;
}

const contributed = build({ ugc: true });

export function renderContributed(markdown: string): SafeHtml {
  return raw(contributed.render(markdown));
}

// The site's own documents (purpose, charter, agent guide). Still no raw HTML;
// repo-relative links are rewritten to the site routes that serve those docs.
const docs = build({
  ugc: false,
  mailto: true,
  rewrite: { "charter.md": "/charter", "purpose.md": "/about", "agent-guide.md": "/agent-guide", "terms.md": "/terms" },
});

export function renderDoc(markdown: string): SafeHtml {
  return raw(docs.render(markdown));
}

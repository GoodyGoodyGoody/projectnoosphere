import type { NoosphereClient } from "./client.ts";

// IndexNow: tell participating search engines (Bing, Yandex, Seznam, Naver,
// Yep) which pages changed, so new records are indexed in minutes rather than
// weeks. The site's server never makes outbound requests (AGENTS.md), so the
// librarian pings, after a night's decisions are applied.
//
// Protocol: https://www.indexnow.org/documentation — one POST of up to 10,000
// URLs; 200 or 202 means accepted; 403 = key not valid, 422 = URLs not on
// this host or key mismatch, 429 = too many requests.

export interface IndexNowConfig {
  host: string;
  key: string;
  key_location: string;
  origin: string;
}

export interface IndexNowResult {
  submitted: number;
  status?: number;
  skipped?: string;
  // Present only on failure. Named "error" on purpose: the bots dashboard's
  // log scan should flag a failed ping.
  error?: string;
}

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

// Decisions that change what a record page shows to the public.
const CHANGES_PUBLIC_PAGE = new Set(["publish_revision", "approve_annotation"]);

export async function changedUrls(
  client: Pick<NoosphereClient, "revision">,
  applied: { action: string; revisionId: string }[],
  origin: string,
): Promise<string[]> {
  const revisionIds = [...new Set(applied.filter((a) => CHANGES_PUBLIC_PAGE.has(a.action) && a.revisionId).map((a) => a.revisionId))];
  const urls = new Set<string>();
  for (const id of revisionIds) {
    const rev = await client.revision(id);
    // Only a record's CURRENT published revision is on its public page; the
    // per-revision pages are noindex, so they are not worth a ping.
    if (rev?.is_current_published && rev.record_slug) urls.add(`${origin}/r/${rev.record_slug}`);
  }
  if (urls.size) urls.add(`${origin}/`); // "Recently published" changed too
  return [...urls];
}

const LOOPBACK = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/;

export async function submitIndexNow(
  cfg: IndexNowConfig,
  urls: string[],
  opts: { fetch?: typeof fetch; endpoint?: string } = {},
): Promise<IndexNowResult> {
  const doFetch = opts.fetch ?? fetch;
  if (!urls.length) return { submitted: 0, skipped: "nothing changed" };
  if (LOOPBACK.test(cfg.host)) return { submitted: 0, skipped: `not a public host (${cfg.host})` };
  const foreign = urls.filter((u) => new URL(u).host !== cfg.host);
  if (foreign.length) return { submitted: 0, error: `refusing URLs outside ${cfg.host}: ${foreign[0]}` };
  // The engines will fetch the key file to verify us; check it first, so a dev
  // copy with a different key (or a broken route) is caught here, not as a 403.
  try {
    const kf = await doFetch(cfg.key_location, { redirect: "manual" });
    const text = (await kf.text()).trim();
    if (kf.status !== 200 || text !== cfg.key) {
      return { submitted: 0, skipped: `key file at ${cfg.key_location} does not serve this key (HTTP ${kf.status})` };
    }
  } catch (e) {
    return { submitted: 0, error: `key file check threw: ${String(e).slice(0, 120)}` };
  }
  let submitted = 0;
  let status = 0;
  for (let i = 0; i < urls.length; i += 10_000) {
    const urlList = urls.slice(i, i + 10_000);
    try {
      const res = await doFetch(opts.endpoint ?? INDEXNOW_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: cfg.host, key: cfg.key, keyLocation: cfg.key_location, urlList }),
      });
      status = res.status;
      if (res.status !== 200 && res.status !== 202) {
        const detail = (await res.text().catch(() => "")).slice(0, 160);
        return { submitted, status, error: `HTTP ${res.status}${detail ? `: ${detail}` : ""}` };
      }
      submitted += urlList.length;
    } catch (e) {
      return { submitted, error: `ping threw: ${String(e).slice(0, 120)}` };
    }
  }
  return { submitted, status };
}

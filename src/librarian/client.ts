// The librarian's only door into Noosphere: the public HTTP API, with its own
// steward token. It never opens the database.
export interface ApiResponse {
  status: number;
  body: any;
}

export class NoosphereClient {
  readonly base: string;
  readonly token: string;
  constructor(base: string, token: string) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
  }

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  async queue(rubricVersion: string, limit = 50) {
    const res = await this.call("GET", `/api/v1/admin/review-queue?rubric_version=${encodeURIComponent(rubricVersion)}&limit=${limit}`);
    if (res.status !== 200) throw new Error(`review queue: HTTP ${res.status}`);
    return res.body as {
      revisions: { revision: any; gate_flags: unknown[]; base_is_stale: boolean; current_published: any }[];
      annotations: { annotation: any; gate_flags: unknown[]; target_revision: any }[];
    };
  }

  // IndexNow settings (steward-only): the key, where it is served, and the host.
  async indexnow(): Promise<{ host: string; key: string; key_location: string; origin: string } | null> {
    const res = await this.call("GET", "/api/v1/admin/indexnow");
    return res.status === 200 ? res.body : null;
  }

  // One exact revision, as the public API shows it (null if not found).
  async revision(id: string): Promise<any | null> {
    const res = await this.call("GET", `/api/v1/revisions/${encodeURIComponent(id)}`);
    return res.status === 200 ? res.body.revision : null;
  }

  // The public sitemap's URLs (for an IndexNow backfill).
  async sitemapUrls(): Promise<string[]> {
    const res = await this.call("GET", "/sitemap.xml");
    if (res.status !== 200 || typeof res.body !== "string") throw new Error(`sitemap: HTTP ${res.status}`);
    return [...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
  }

  // Idempotent: a rerun after a crash replays instead of double-applying.
  async moderate(action: string, targetId: string, reason: string, rubricVersion: string): Promise<ApiResponse> {
    return this.call(
      "POST",
      "/api/v1/admin/moderation-events",
      { action, target_id: targetId, reason, rubric_version: rubricVersion },
      { "idempotency-key": `librarian:${rubricVersion}:${targetId}:${action}` },
    );
  }
}

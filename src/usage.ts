import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { authenticate } from "./auth.ts";
import type { DB } from "./db.ts";
import { normalizeIp } from "./limits.ts";

// Private, aggregate usage counts (migration 007, `npm run usage`): does anyone
// really use Noosphere, with which tools and clients, what do they look for,
// and what finds nothing?
//
// - Nothing written holds a client address, a user agent or a contributor id:
//   calls are counted per (day, tool, channel, client label, status class);
//   searches keep only their normalized text (or "[withheld]"); visitors are an
//   HMAC under a key that changes every month.
// - Counting never slows or fails a request. Requests only touch memory, after
//   the response is sent; a timer writes the batch. A counting error is logged
//   once and swallowed. Memory is bounded everywhere.

export type Channel = "mcp" | "web" | "house" | "probe";
// "page" = an outside caller that only read pages (never used a tool): one
// separate number, never counted as a returning user.
export type VisitorClass = "outside" | "house" | "probe" | "page";
export type Tool =
  | "search" | "get_record" | "get_revision" | "list" | "create_record" | "propose_revision"
  | "report_outcome" | "annotate" | "register" | "connect" | "other";

export const SEARCH_RETENTION_DAYS = 30;
export const WITHHELD = "[withheld]";
export const OVER_CAP_QUERY = "[other]";
const CALLER_TTL_MS = 30 * 60 * 1000;
const DAY_MS = 86_400_000;

// ---- labels and rules ---------------------------------------------------------

export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const isoMonth = (ms: number): string => new Date(ms).toISOString().slice(0, 7);

export function statusClass(status: number): "2xx" | "3xx" | "4xx" | "5xx" {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

// A short, safe label from a client's own name, e.g. "claude-code/1". Anything
// that isn't a plain product name (spaces aside) becomes "other": no free text,
// no addresses, no emails reach the database through it.
export function clientLabel(name: string | undefined, version?: string): string {
  const s = (name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z][a-z0-9._-]{0,31}$/.test(s)) return "other";
  if (/\d{1,3}[.-]\d{1,3}[.-]\d{1,3}|\d{5,}/.test(s)) return "other";
  const major = /^v?(\d{1,4})(?:\D|$)/.exec(version ?? "")?.[1];
  return major !== undefined ? `${s}/${Number(major)}` : s;
}

// A caller is a probe when its user agent (or MCP client name) says so: one of
// these words, or a "+http" contact URL, the convention for automated fetchers.
// A rule, not a list of known checkers. A product token ending in "-User"
// (ChatGPT-User, Claude-User, Perplexity-User) is the opposite convention: a
// fetch made because a person asked for it, so it is outside use.
const PROBE_WORD = /bot|probe|uptime|monitor|crawl|spider|scan|check|watch|validat|preview|headless/i;
export function isProbeAgent(s: string | undefined): boolean {
  if (!s) return false;
  if (/[a-z]-user\b/i.test(s)) return false;
  return PROBE_WORD.test(s) || /\+https?:/i.test(s);
}

// Scanners, by rule: no user agent, "-", or a URL as the user agent.
export function isScannerAgent(ua: string | undefined): boolean {
  const s = (ua ?? "").trim();
  return s === "" || s === "-" || /^https?:\/\//i.test(s);
}

// Well-known scanner targets (the site has no PHP at all).
const SCANNER_PATH = /wp-admin|wp-login|wp-content|wp-includes|xmlrpc\.php|\/\.env|\/\.git(?:\/|$)|phpmyadmin|cgi-bin|\/vendor\/phpunit|\.php(?:$|[/?#])/i;
export function isScannerPath(url: string | undefined): boolean {
  return !!url && SCANNER_PATH.test(url);
}

interface Family { name: string; label: string }

// The user agent's family, e.g. "curl/8", "chrome/141", "chatgpt-user/1".
export function uaFamily(ua: string | undefined): Family {
  if (!ua) return { name: "other", label: "other" };
  const tokens = [...ua.matchAll(/([A-Za-z][A-Za-z0-9._-]*)\/v?(\d+)/g)].map((m) => ({ name: m[1]!, major: m[2]! }));
  const lead = /^\s*([A-Za-z][A-Za-z0-9._-]*)/.exec(ua)?.[1];
  const pick = (t: { name: string; major?: string } | undefined): Family => {
    const label = clientLabel(t?.name, t?.major);
    return { name: label === "other" ? "other" : label.split("/")[0]!, label };
  };
  // Who is really calling: an agent fetcher or a probe names itself somewhere.
  const self = tokens.find((t) => /-user$/i.test(t.name) || isProbeAgent(t.name))
    ?? (lead && (/-user$/i.test(lead) || isProbeAgent(lead)) ? { name: lead } : undefined);
  if (self) return pick(self);
  if (/^Mozilla\//.test(ua)) {
    for (const [token, name] of [["Edg", "edge"], ["OPR", "opera"], ["Firefox", "firefox"], ["Chrome", "chrome"], ["Version", "safari"]] as const) {
      const t = tokens.find((x) => x.name === token);
      if (t) return pick({ name, major: t.major });
    }
    return { name: "other", label: "other" };
  }
  return pick(tokens[0] ?? (lead ? { name: lead } : undefined));
}

// Search text as kept: trimmed, whitespace collapsed, lowercased, at most 200
// characters, or "[withheld]" when it looks like a secret or personal data.
const SECRET_PATTERNS: RegExp[] = [
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i, // an email address
  /(?:^|[^a-z0-9])(?:sk-|sk_|rk_|pk_|ghp_|gho_|ghs_|github_pat_|xox[a-z]?-|nsp_|glpat-)/i, // key prefixes
  /AKIA[0-9A-Z]{8,}/, // AWS access key id
  /-----BEGIN/i,
  /\bbearer\s+\S{12,}/i,
  /[0-9a-f]{24,}/i, // a long hex run
  // A credential written as name=value or name: value.
  /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|auth\w*)\s*[=:]\s*\S+/i,
];
function looksSecret(q: string): boolean {
  if (SECRET_PATTERNS.some((re) => re.test(q))) return true;
  // A phone number: 9+ digits written as one number (separators allowed).
  for (const m of q.matchAll(/\+?\d[\d\s().-]{7,}\d/g)) if (m[0].replace(/\D/g, "").length >= 9) return true;
  // A long base64 run: mixed case and digits, the shape of a key, not a word.
  for (const m of q.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)) {
    if (/\d/.test(m[0]) && /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0])) return true;
  }
  return false;
}
export function normalizeQuery(q: string): string {
  const collapsed = q.trim().replace(/\s+/g, " ");
  if (looksSecret(collapsed)) return WITHHELD;
  return collapsed.toLowerCase().slice(0, 200);
}

// The server itself: its own scripts and agents calling it directly. Behind
// nginx (TRUST_PROXY) req.ip is the forwarded client, never loopback.
export function isLoopback(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, "");
  return (isIP(v) === 4 && v.startsWith("127.")) || v === "::1";
}

// This machine's own addresses (every non-internal interface address), read
// from the OS, never hand-kept. The server's scripts and probes reach it
// through nginx via its public address, so req.ip is one of these. Refreshed
// at most once a minute.
let ownCache: { at: number; set: Set<string> } | undefined;
function ownAddresses(): Set<string> {
  const now = Date.now();
  if (ownCache && now - ownCache.at < 60_000) return ownCache.set;
  const set = new Set<string>();
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (!a.internal) set.add(a.address.toLowerCase());
    }
  } catch {
    // keep whatever we have
  }
  ownCache = { at: now, set };
  return set;
}

// Test hook: pretend these are this machine's addresses.
export function setOwnAddressesForTest(addrs: string[]): void {
  ownCache = { at: Date.now() + 3_600_000, set: new Set(addrs.map((a) => a.toLowerCase())) };
}

export function isServerAddress(ip: string): boolean {
  if (isLoopback(ip)) return true;
  return ownAddresses().has(ip.replace(/^::ffff:/i, "").toLowerCase());
}

// The site operator's own agents (PROGRESS.md, house agents) and the steward
// (the librarian). An invalid or unknown token is simply not house.
export const HOUSE_SUFFIX = "(site operator's agent)";
export function isHouseToken(db: DB, authorization: string | undefined): boolean {
  if (!authorization) return false;
  try {
    const actor = authenticate(db, authorization);
    return actor.role === "steward" || actor.displayName.endsWith(HOUSE_SUFFIX);
  } catch {
    return false;
  }
}

// ---- the counter ----------------------------------------------------------------

export interface UsageOptions {
  now?: () => number;
  // Distinct (tool, channel, client, status) keys per day; past it, client = "other".
  keyCap?: number;
  // Distinct searches per day; past it, query = "[other]".
  searchCap?: number;
  // Distinct visitors held between writes; past it, new ones wait for the next write.
  visitorCap?: number;
  // MCP callers remembered for their client name.
  callerCap?: number;
  flushMs?: number;
  log?: (msg: string, err: unknown) => void;
}

interface Pending { day: string; status: string; visitor: { month: string; hash: string; day: string } | null }
interface McpCaller { client?: string; lastSeen: number; real: boolean; pending: Map<string, number>; visitor: Pending["visitor"] }
export interface InnerCall { channel: Channel; client: string; counted: boolean }

const MCP_TOOLS: Record<string, Tool> = {
  search: "search", get_revision: "get_revision", report_outcome: "report_outcome", annotate: "annotate",
  create_record: "create_record", propose_revision: "propose_revision",
};

export class Usage {
  private readonly now: () => number;
  private readonly keyCap: number;
  private readonly searchCap: number;
  private readonly visitorCap: number;
  private readonly callerCap: number;
  private readonly log: (msg: string, err: unknown) => void;
  private counts = new Map<string, number>();
  private searches = new Map<string, { count: number; results: number }>();
  private visits = new Map<string, { firstDay: string; mask: number }>();
  private seenKeys = { day: "", counts: new Set<string>(), searches: new Set<string>() };
  private key: { month: string; key: string } | null = null;
  private lastSweep = 0;
  private failing = false;
  private timer: NodeJS.Timeout | null = null;
  // In memory only, never written: who an MCP caller said it was, keyed by a
  // hash of address + user agent, for 30 minutes.
  readonly callers = new Map<string, McpCaller>();
  readonly inner = new Map<string, InnerCall>();
  // Visitor hashes that asked for a scanner path today (memory only, bounded).
  private scanners = { day: "", hashes: new Set<string>() };

  private readonly db: DB;

  constructor(db: DB, opts: UsageOptions = {}) {
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.keyCap = opts.keyCap ?? 2000;
    this.searchCap = opts.searchCap ?? 5000;
    this.visitorCap = opts.visitorCap ?? 20_000;
    this.callerCap = opts.callerCap ?? 10_000;
    this.log = opts.log ?? ((msg, err) => console.error(msg, err));
    if (opts.flushMs) {
      this.timer = setInterval(() => this.flush(), opts.flushMs);
      this.timer.unref();
    }
  }

  // Logged once per run of failures, then quiet until a write succeeds again.
  warn(err: unknown): void {
    if (this.failing) return;
    this.failing = true;
    this.log("usage counting failed (requests are unaffected)", err);
  }

  private today(): string {
    const day = isoDay(this.now());
    if (this.seenKeys.day !== day) this.seenKeys = { day, counts: new Set(), searches: new Set() };
    return day;
  }

  count(tool: Tool, channel: Channel, client: string, status: number | string, day = this.today()): void {
    const sc = typeof status === "number" ? statusClass(status) : status;
    let key = `${day}|${tool}|${channel}|${client}|${sc}`;
    if (day === this.seenKeys.day && !this.seenKeys.counts.has(key)) {
      if (this.seenKeys.counts.size >= this.keyCap) key = `${day}|${tool}|${channel}|other|${sc}`;
      else this.seenKeys.counts.add(key);
    }
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  search(channel: Channel, client: string, q: string, results: number): void {
    const day = this.today();
    let query = normalizeQuery(q);
    if (!query) return;
    let key = `${day}|${query}|${channel}|${client}`;
    if (!this.seenKeys.searches.has(key)) {
      if (this.seenKeys.searches.size >= this.searchCap) {
        query = OVER_CAP_QUERY;
        key = `${day}|${query}|${channel}|other`;
      } else this.seenKeys.searches.add(key);
    }
    const prev = this.searches.get(key);
    this.searches.set(key, { count: (prev?.count ?? 0) + 1, results });
  }

  // The visitor's hash under this month's key. The address and user agent are
  // used here and dropped; only the hash is kept.
  visitorHash(ip: string, family: string): { month: string; hash: string; day: string } | null {
    const nowMs = this.now();
    const month = isoMonth(nowMs);
    const key = this.monthKey(month);
    const hash = createHmac("sha256", key).update(`${normalizeIp(ip)}\n${family}`).digest("hex").slice(0, 32);
    return { month, hash, day: isoDay(nowMs) };
  }

  markScanner(hash: string): void {
    const day = this.today();
    if (this.scanners.day !== day) this.scanners = { day, hashes: new Set() };
    if (this.scanners.hashes.size < this.callerCap) this.scanners.hashes.add(hash);
  }

  isScanner(hash: string): boolean {
    return this.scanners.day === this.today() && this.scanners.hashes.has(hash);
  }

  visit(cls: VisitorClass, v: { month: string; hash: string; day: string } | null): void {
    if (!v) return;
    const key = `${v.month}|${cls}|${v.hash}`;
    const prev = this.visits.get(key);
    if (!prev && this.visits.size >= this.visitorCap) return;
    const bit = 1 << (Number(v.day.slice(8, 10)) - 1);
    this.visits.set(key, { firstDay: prev && prev.firstDay < v.day ? prev.firstDay : v.day, mask: (prev?.mask ?? 0) | bit });
  }

  // This month's visitor key. At the first use in a new month, a new key
  // replaces the old one and the old month's hashes are deleted, together.
  private monthKey(month: string): string {
    if (this.key?.month === month) return this.key.key;
    const read = () => {
      const v = this.db.prepare("SELECT value FROM settings WHERE key = 'usage_visitor_key'").pluck().get() as string | undefined;
      const [m, k] = (v ?? "").split(":");
      return m && k ? { month: m, key: k } : null;
    };
    let cur = read();
    if (cur?.month !== month) {
      cur = this.db.transaction(() => {
        const again = read();
        if (again?.month === month) return again;
        const fresh = { month, key: randomBytes(32).toString("hex") };
        this.db.prepare("DELETE FROM usage_visitors WHERE month != ?").run(month);
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('usage_visitor_key', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
          .run(`${fresh.month}:${fresh.key}`);
        return fresh;
      }).immediate();
    }
    this.key = cur;
    return cur.key;
  }

  // ---- hosted MCP ---------------------------------------------------------------

  private caller(ip: string, ua: string): { key: string; entry: McpCaller | undefined } {
    const key = createHash("sha256").update(`${ip}\n${ua}`).digest("hex");
    const entry = this.callers.get(key);
    if (entry && this.now() - entry.lastSeen > CALLER_TTL_MS) {
      this.releaseCaller(key, entry);
      return { key, entry: undefined };
    }
    return { key, entry };
  }

  // A caller that only ever connected (initialize, tools/list, ...) is a probe.
  private releaseCaller(key: string, entry: McpCaller): void {
    this.callers.delete(key);
    if (entry.real || !entry.pending.size) return;
    for (const [k, n] of entry.pending) {
      const [day, status] = k.split("|") as [string, string];
      for (let i = 0; i < n; i++) this.count("connect", "probe", entry.client ?? "other", status, day);
    }
    this.visit("probe", entry.visitor);
  }

  private touchCaller(key: string, entry: McpCaller): void {
    entry.lastSeen = this.now();
    this.callers.delete(key);
    this.callers.set(key, entry);
    while (this.callers.size > this.callerCap) {
      const [oldKey, oldest] = this.callers.entries().next().value!;
      this.releaseCaller(oldKey, oldest);
    }
  }

  // One POST to /mcp. Returns the id its in-process API calls carry, and a
  // function to call when the response is done. Never throws.
  mcpBegin(req: { ip: string; headers: Record<string, string | string[] | undefined>; body: unknown }): {
    nonce: string | null;
    finish: (status: number) => void;
  } {
    const none = { nonce: null, finish: () => {} };
    try {
      const messages = (Array.isArray(req.body) ? req.body : [req.body]).filter((m): m is Record<string, any> => !!m && typeof m === "object");
      if (!messages.length) return none;
      let info: { name?: unknown; version?: unknown } | undefined;
      let toolName: string | undefined;
      for (const m of messages) {
        const params = m.params && typeof m.params === "object" ? m.params : {};
        if (params.clientInfo && typeof params.clientInfo === "object") info = params.clientInfo;
        const meta = params._meta && typeof params._meta === "object" ? params._meta : {};
        for (const [k, v] of Object.entries(meta)) if (/clientInfo$/i.test(k) && v && typeof v === "object") info = v as typeof info;
        if (m.method === "tools/call" && typeof params.name === "string") toolName = params.name;
      }
      const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
      const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const fam = uaFamily(ua);
      const { key, entry: found } = this.caller(req.ip, ua);
      const infoName = typeof info?.name === "string" ? info.name : undefined;
      const said = infoName !== undefined ? clientLabel(infoName, typeof info?.version === "string" ? info.version : undefined) : undefined;
      const client = said ?? found?.client ?? fam.label;
      const house = isServerAddress(req.ip) || isHouseToken(this.db, auth);
      const probe = !house && (isProbeAgent(ua) || isProbeAgent(infoName ?? found?.client));
      const channel: Channel = house ? "house" : probe ? "probe" : "mcp";
      const cls: VisitorClass = house ? "house" : probe ? "probe" : "outside";
      const visitor = this.visitorHash(req.ip, fam.name);
      const day = this.today();
      // Every caller's name is remembered; only outside callers' handshakes wait
      // to learn whether they are real use or a probe.
      const remembered: McpCaller = found ?? { lastSeen: 0, real: false, pending: new Map(), visitor };
      if (said) remembered.client = said;
      remembered.visitor = visitor;
      this.touchCaller(key, remembered);
      const entry = channel === "mcp" ? remembered : undefined;
      const nonce = toolName ? randomBytes(16).toString("hex") : null;
      const call: InnerCall = { channel, client, counted: false };
      if (nonce) this.inner.set(nonce, call);
      return {
        nonce,
        finish: (status) => {
          try {
            if (nonce) this.inner.delete(nonce);
            if (toolName) {
              // A tool that never reached the API (no token, invalid arguments)
              // still counts, as a client error.
              if (!call.counted) this.count(MCP_TOOLS[toolName] ?? "other", channel, client, "4xx");
              if (entry && !entry.real) {
                entry.real = true;
                for (const [k, n] of entry.pending) {
                  const [d, s] = k.split("|") as [string, string];
                  for (let i = 0; i < n; i++) this.count("connect", "mcp", client, s, d);
                }
                entry.pending.clear();
              }
              this.visit(cls, visitor);
            } else if (entry && !entry.real) {
              // Held until the caller either calls a tool or goes quiet.
              const k = `${day}|${statusClass(status)}`;
              if (entry.pending.size < 50 || entry.pending.has(k)) entry.pending.set(k, (entry.pending.get(k) ?? 0) + 1);
            } else {
              this.count("connect", channel, client, status);
              this.visit(cls, visitor);
            }
          } catch (err) {
            this.warn(err);
          }
        },
      };
    } catch (err) {
      this.warn(err);
      return none;
    }
  }

  // ---- writing ------------------------------------------------------------------

  // One transaction per batch. Swallows (and logs once) any error: the batch
  // is dropped rather than retried, so memory never grows while failing.
  flush(): void {
    const counts = this.counts;
    const searches = this.searches;
    const visits = this.visits;
    this.counts = new Map();
    this.searches = new Map();
    this.visits = new Map();
    try {
      const nowMs = this.now();
      for (const [k, entry] of [...this.callers]) {
        if (nowMs - entry.lastSeen > CALLER_TTL_MS) this.releaseCaller(k, entry);
      }
      // Anything quiet callers left behind is written in this same batch.
      for (const [k, n] of this.counts) counts.set(k, (counts.get(k) ?? 0) + n);
      for (const [k, v] of this.visits) visits.set(k, v);
      this.counts = new Map();
      this.visits = new Map();
      const sweepDue = nowMs - this.lastSweep >= 3600_000;
      // Idle: no write lock taken at all.
      if (!counts.size && !searches.size && !visits.size && !sweepDue) return;
      const month = isoMonth(nowMs);
      this.monthKey(month);
      this.db.transaction(() => {
        const addCount = this.db.prepare(
          `INSERT INTO usage_counts (day, tool, channel, client, status_class, count) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (day, tool, channel, client, status_class) DO UPDATE SET count = count + excluded.count`,
        );
        for (const [k, n] of counts) {
          const [day, tool, channel, client, sc] = k.split("|");
          addCount.run(day, tool, channel, client, sc, n);
        }
        const addSearch = this.db.prepare(
          `INSERT INTO usage_searches (day, query, channel, client, count, result_count, zero_results) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (day, query, channel, client) DO UPDATE SET count = count + excluded.count,
             result_count = excluded.result_count, zero_results = excluded.zero_results`,
        );
        for (const [k, s] of searches) {
          // The query may itself contain "|": the other fields never do.
          const parts = k.split("|");
          const day = parts[0]!;
          const client = parts.at(-1)!;
          const channel = parts.at(-2)!;
          const query = parts.slice(1, -2).join("|");
          addSearch.run(day, query, channel, client, s.count, s.results, s.results === 0 ? 1 : 0);
        }
        const addVisit = this.db.prepare(
          `INSERT INTO usage_visitors (month, class, hash, first_day, days_mask) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (month, class, hash) DO UPDATE SET days_mask = days_mask | excluded.days_mask,
             first_day = min(first_day, excluded.first_day)`,
        );
        for (const [k, v] of visits) {
          const [m, cls, hash] = k.split("|");
          if (m === month) addVisit.run(m, cls, hash, v.firstDay, v.mask);
        }
        if (sweepDue) this.sweep(nowMs);
      }).immediate();
      this.failing = false;
    } catch (err) {
      this.warn(err);
    }
  }

  // Searches are kept 30 days: a row from 30 or more days ago is deleted.
  sweep(nowMs = this.now()): void {
    this.db.prepare("DELETE FROM usage_searches WHERE day <= ?").run(isoDay(nowMs - SEARCH_RETENTION_DAYS * DAY_MS));
    this.lastSweep = nowMs;
  }

  // At shutdown: every remembered caller is settled and the last batch written.
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      for (const [k, entry] of [...this.callers]) this.releaseCaller(k, entry);
    } catch (err) {
      this.warn(err);
    }
    this.flush();
  }
}

// ---- Fastify wiring -----------------------------------------------------------------

// The header an in-process API call made by a hosted MCP tool carries
// (src/mcp-http.ts). Its value is a random id known only to this process, so
// an outside caller sending it is just counted as itself.
export const INNER_HEADER = "x-noosphere-usage";

interface CountableRequest {
  ip: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
  body: unknown;
  url?: string;
  routeOptions: { url?: string };
  usageSearch: { q: string; results: number } | null;
}

// Runs after the response is sent (onResponse). Memory only; never throws.
export function countRequest(usage: Usage, db: DB, req: CountableRequest, status: number): void {
  try {
    const route = req.routeOptions.url;
    // /mcp counts itself (mcpBegin); health checks are operations, not use.
    if (route === "/mcp" || route === "/healthz" || route === "/readyz") return;
    const tool = toolFor(req.method, route, req.query, req.body);
    const nonce = req.headers[INNER_HEADER];
    const inner = typeof nonce === "string" ? usage.inner.get(nonce) : undefined;
    if (inner) {
      // One MCP tool call is one count: get_revision's later reads are not.
      if (inner.counted) return;
      inner.counted = true;
      usage.count(tool, inner.channel, inner.client, status);
      if (req.usageSearch) usage.search(inner.channel, inner.client, req.usageSearch.q, req.usageSearch.results);
      return;
    }
    const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "";
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    const fam = uaFamily(ua);
    const house = isServerAddress(req.ip) || isHouseToken(db, auth);
    const visitor = usage.visitorHash(req.ip, fam.name);
    // A caller that asked for a scanner path is a probe for the rest of the day.
    const scanner = isScannerPath(req.url);
    if (scanner && !house && visitor) usage.markScanner(visitor.hash);
    const probe = !house && (isProbeAgent(ua) || isScannerAgent(ua) || scanner || (!!visitor && usage.isScanner(visitor.hash)));
    const channel: Channel = house ? "house" : probe ? "probe" : "web";
    usage.count(tool, channel, fam.label, status);
    if (req.usageSearch) usage.search(channel, fam.label, req.usageSearch.q, req.usageSearch.results);
    // Only a request that used a tool makes a visitor; outside page reads are
    // one separate number.
    if (tool !== "other") usage.visit(channel === "web" ? "outside" : channel, visitor);
    else if (channel === "web") usage.visit("page", visitor);
  } catch (err) {
    usage.warn(err);
  }
}

// ---- which tool a request is ------------------------------------------------------

const ROUTE_TOOLS: Record<string, Tool> = {
  "GET /api/v1/search": "search",
  "GET /api/v1/records/:record_id": "get_record",
  "GET /r/:slug": "get_record",
  "GET /api/v1/revisions/:revision_id": "get_revision",
  "GET /api/v1/revisions/:revision_id/markdown": "get_revision",
  "GET /r/:slug/revisions/:revision_id": "get_revision",
  "GET /api/v1/records": "list",
  "GET /api/v1/records/:record_id/revisions": "list",
  "GET /api/v1/revisions/:revision_id/annotations": "list",
  "GET /api/v1/revisions/:revision_id/report-history": "list",
  "POST /api/v1/records": "create_record",
  "POST /api/v1/records/:record_id/revisions": "propose_revision",
  "POST /api/v1/contributors": "register",
};

export function toolFor(method: string, route: string | undefined, query: unknown, body: unknown): Tool {
  const m = method === "HEAD" ? "GET" : method;
  if (m === "GET" && route === "/search") {
    const q = (query as { q?: unknown } | null)?.q;
    return typeof q === "string" && q.trim() ? "search" : "other";
  }
  if (m === "POST" && route === "/api/v1/revisions/:revision_id/annotations") {
    return (body as { kind?: unknown } | null)?.kind === "outcome_report" ? "report_outcome" : "annotate";
  }
  return (route && ROUTE_TOOLS[`${m} ${route}`]) || "other";
}

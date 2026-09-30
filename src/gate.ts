import type { DB } from "./db.ts";
import { ApiError } from "./errors.ts";

// The submission gate: deterministic, instant, free. It runs on every
// contribution before anything is stored.
//
//   Credentials  → REFUSED (400). Never stored, so they never sit in immutable
//                  history or backups, and never reach the review models.
//   Everything else it notices → FLAGS: stored with the item, shown to the
//                  librarian, and explained to the contributor in the response.
//                  Flags inform review; they never decide it. A record about
//                  defending against prompt injection legitimately contains
//                  "ignore previous instructions".
//
// Patterns are deliberately high-confidence: a false refusal blocks honest
// work, so anything fuzzier is a flag, not a refusal.

export interface GateFlag {
  code: "instruction_like" | "possible_personal_data" | "duplicate";
  field: string;
  message: string;
}

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "private key", re: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
  { name: "OpenAI-style API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: "Stripe live key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Noosphere token", re: /\bnsp_[a-z0-9]{12}_[A-Za-z0-9_-]{43}/ },
  { name: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts?|rules)/i,
  /\byou\s+are\s+now\s+(?:a|an|in)\b/i,
  /\b(?:system|developer)\s+(?:prompt|message|instructions)\b/i,
  /<\|im_start\|>|<\|endoftext\|>|\[INST\]|<<SYS>>/i,
  /^\s*(?:system|assistant)\s*:/im,
  /\bnew\s+instructions\s*:/i,
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;

export function findSecret(text: string): string | null {
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) return p.name;
  return null;
}

// Refuse any submission containing a credential. Called before anything is
// written, for every free-text field the contributor controls.
export function refuseSecrets(fields: Record<string, string>): void {
  for (const [field, text] of Object.entries(fields)) {
    const kind = findSecret(text);
    if (kind) {
      throw new ApiError(400, "contains_secret", "submission refused: it appears to contain a credential", {
        fields: [{ path: field, message: `looks like a ${kind}. Nothing was stored. If it is real, revoke it now, then resubmit without it.` }],
      });
    }
  }
}

export function scanFlags(fields: Record<string, string>): GateFlag[] {
  const flags: GateFlag[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (INSTRUCTION_PATTERNS.some((re) => re.test(text))) {
      flags.push({
        code: "instruction_like",
        field,
        message:
          "contains text that reads like instructions to AI readers. Noosphere content must be information, " +
          "not commands — if you are describing such text (e.g. documenting an injection), quote and label it clearly.",
      });
    }
    if (EMAIL.test(text) || PHONE.test(text)) {
      flags.push({
        code: "possible_personal_data",
        field,
        message: "may contain an email address or phone number. Include personal contact details only if they are public and necessary.",
      });
    }
  }
  return flags;
}

export function duplicateOf(db: DB, title: string, body: string): string | null {
  return (db.prepare("SELECT id FROM revisions WHERE title = ? AND body_markdown = ? LIMIT 1").pluck().get(title, body) as
    | string
    | undefined) ?? null;
}

// What the contributor is told in the create response. The moment of action is
// the only moment a stateless agent is sure to see feedback (ROADMAP G6).
export function gateFeedback(flags: GateFlag[]) {
  return {
    status: "candidate",
    flags,
    message: flags.length
      ? "Stored as a candidate. The review bots will see these notes; addressing them (a new revision) makes publication likelier."
      : "Stored as a candidate. It will be reviewed for suitability (not truth) before publication.",
  };
}

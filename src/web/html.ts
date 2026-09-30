// Escape-by-default HTML templating. Every interpolated value is escaped unless
// it is already SafeHtml; only raw() — for rendered Markdown and fixed trusted
// fragments — produces SafeHtml from a string. Contributor text (titles,
// summaries, names, tags, conditions, source notes, URLs) must never reach raw().
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export function raw(trusted: string): SafeHtml {
  return new SafeHtml(trusted);
}

function render(value: unknown): string {
  if (value instanceof SafeHtml) return value.value;
  if (value === null || value === undefined || value === false) return "";
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new SafeHtml(out);
}

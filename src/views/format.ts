// src/views/format.ts — display helpers shared across components.

export function relativeTime(mtimeMs: number): string {
  const diff = Date.now() - mtimeMs;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function fmtTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const c of content) if (c?.type === "text" && typeof c.text === "string") out.push(c.text);
  return out.join("\n");
}

export function basenamePath(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function basenameDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

export function uniqueWithCount(items: string[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

export function truncate(s: string, n: number): { text: string; truncated: boolean } {
  if (s.length <= n) return { text: s, truncated: false };
  return { text: s.slice(0, n), truncated: true };
}

/** First useful arg per known tool ("bash" → command, "read" → path, …) for one-line previews. */
export function oneLineArgs(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const candidates: Record<string, string[]> = {
    bash: ["command"],
    read: ["path"],
    edit: ["path"],
    write: ["path"],
    grep: ["pattern", "path"],
    glob: ["pattern"],
  };
  const keys = candidates[toolName] ?? Object.keys(args);
  for (const k of keys) {
    const v = (args as any)[k];
    if (typeof v === "string") return v.length > 100 ? v.slice(0, 100) + "…" : v;
  }
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v);
      return s.length > 100 ? s.slice(0, 100) + "…" : `${k}=${s}`;
    }
  }
  return "";
}

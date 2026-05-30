// src/engine/filter.ts — query string → predicate.
//
// Syntax (all AND together):
//   has:image / images / has:diff / diffs / has:error / errors
//   partial / subagent / has:intercom / intercom
//   tool:<name>     e.g. tool:edit
//   cwd:<substr>
//   peer:<substr>   intercom peer name
//   <bare>          substring match on name/cwd/id/model

import type { Summary } from "../types.ts";

export type FilterState = {
  q: string;
  freeText: string[];
  needs: {
    image?: boolean;
    error?: boolean;
    diff?: boolean;
    partial?: boolean;
    subagent?: boolean;
    intercom?: boolean;
  };
  tools: string[];
  cwd: string[];
  peer: string[];
};

export function parseFilter(q: string): FilterState {
  const state: FilterState = { q, freeText: [], needs: {}, tools: [], cwd: [], peer: [] };
  if (!q) return state;
  for (const raw of q.split(/\s+/)) {
    if (!raw) continue;
    const tok = raw.toLowerCase();
    if (tok === "has:image" || tok === "images") state.needs.image = true;
    else if (tok === "has:error" || tok === "errors") state.needs.error = true;
    else if (tok === "has:diff" || tok === "diffs") state.needs.diff = true;
    else if (tok === "partial") state.needs.partial = true;
    else if (tok === "subagent") state.needs.subagent = true;
    else if (tok === "has:intercom" || tok === "intercom") state.needs.intercom = true;
    else if (tok.startsWith("tool:")) state.tools.push(tok.slice(5));
    else if (tok.startsWith("cwd:")) state.cwd.push(tok.slice(4));
    else if (tok.startsWith("peer:")) state.peer.push(tok.slice(5));
    else state.freeText.push(tok);
  }
  return state;
}

export function applyFilter(s: Summary, f: FilterState): boolean {
  if (f.needs.image && !s.hasImages) return false;
  if (f.needs.error && !s.hasErrors) return false;
  if (f.needs.diff && !s.hasDiffs) return false;
  if (f.needs.partial && !s.partial) return false;
  if (f.needs.subagent && !s.isSubagent) return false;
  if (f.needs.intercom && !s.hasIntercom) return false;
  if (f.tools.length) {
    const lower = s.toolNames.map((t) => t.toLowerCase());
    for (const t of f.tools) if (!lower.includes(t)) return false;
  }
  if (f.cwd.length) {
    const haystack = (s.cwd ?? "").toLowerCase();
    for (const c of f.cwd) if (!haystack.includes(c)) return false;
  }
  if (f.peer.length) {
    const lower = s.intercomPeers.map((p) => p.toLowerCase());
    for (const p of f.peer) if (!lower.some((q) => q.includes(p))) return false;
  }
  if (f.freeText.length) {
    const haystack = [s.name ?? "", s.cwd ?? "", s.id, s.lastModel ?? ""].join(" ").toLowerCase();
    for (const t of f.freeText) if (!haystack.includes(t)) return false;
  }
  return true;
}

// src/engine/store.ts — session enumeration + summary cache.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSession, readEntries, summarize } from "../parser/index.ts";
import type { Summary } from "../types.ts";

/**
 * Pick a default sessions directory. Different pi profiles use different
 * locations: ~/.pi/agent/sessions/ is the documented one; some setups
 * (including the spike's host) keep them under ~/.config/pi/sessions/.
 */
export function defaultSessionsDir(): string {
  const a = join(homedir(), ".pi", "agent", "sessions");
  if (existsSync(a)) return a;
  const b = join(homedir(), ".config", "pi", "sessions");
  if (existsSync(b)) return b;
  return a;
}

/** Walk the sessions directory and one level of project subdirs (encoded cwd dirs). */
export function enumerateSessionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isFile() && ent.name.endsWith(".jsonl")) {
      out.push(p);
    } else if (ent.isDirectory()) {
      try {
        for (const f of readdirSync(p)) if (f.endsWith(".jsonl")) out.push(join(p, f));
      } catch {
        /* skip unreadable subdirs */
      }
    }
  }
  return out;
}

type CacheEntry = { path: string; summary: Summary; mtime: number };

/**
 * Mtime-validated summary cache. Cheap: a touched session re-parses; an
 * untouched one is served from memory in microseconds.
 */
export class SessionStore {
  readonly sessionsDir: string;
  readonly archiveDir: string;
  private cache = new Map<string, CacheEntry>();
  private pathById = new Map<string, string>();

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
    this.archiveDir = sessionsDir.replace(/\/$/, "") + "-archive";
  }

  /** Resolve a session id back to its absolute path. May trigger a refresh. */
  async pathFor(id: string): Promise<string | undefined> {
    if (this.pathById.has(id)) return this.pathById.get(id);
    await this.refresh();
    return this.pathById.get(id);
  }

  /** Remove a path from caches (after deletion). */
  evict(path: string, id?: string): void {
    this.cache.delete(path);
    if (id) this.pathById.delete(id);
  }

  /** Build all summaries — re-parses only touched files. */
  async refresh(): Promise<Summary[]> {
    const files = [
      ...enumerateSessionFiles(this.sessionsDir),
      ...enumerateSessionFiles(this.archiveDir),
    ];
    const summaries: Summary[] = [];
    for (const path of files) {
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      const cached = this.cache.get(path);
      if (cached && cached.mtime === stat.mtimeMs) {
        summaries.push(cached.summary);
        continue;
      }
      try {
        const parsed = await readEntries(path);
        const summary = summarize(path, parsed);
        this.cache.set(path, { path, summary, mtime: stat.mtimeMs });
        this.pathById.set(summary.id, path);
        summaries.push(summary);
      } catch (err) {
        console.error(`[store] summary failed for ${path}: ${(err as Error).message}`);
      }
    }
    summaries.sort((a, b) => b.mtime - a.mtime);
    return summaries;
  }

  /** Full parse (header + entries + tree-ready summary) for a single session. */
  async load(path: string) {
    return parseSession(path);
  }
}

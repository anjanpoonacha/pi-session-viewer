// src/engine/tombstones.ts — viewer-only entry hiding (sidecar JSON store).
//
// Tombstones do NOT modify the JSONL. They are a viewer-side filter, fully
// reversible. Pi reads the original session unchanged — useful when you want
// to declutter the view without affecting the agent's context.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Entry } from "../types.ts";

const TOMBSTONE_FILE = join(homedir(), ".pi", "session-viewer", "tombstones.json");

type Record = { ts: string; reason?: string };
type Store = { [sessionId: string]: { [entryId: string]: Record } };

export class TombstoneStore {
  private data: Store;

  constructor() {
    this.data = this.load();
  }

  private load(): Store {
    try {
      if (!existsSync(TOMBSTONE_FILE)) return {};
      const raw = readFileSync(TOMBSTONE_FILE, "utf8");
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch (err) {
      console.error(`[tombstones] load failed: ${(err as Error).message}`);
      return {};
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(TOMBSTONE_FILE), { recursive: true });
      writeFileSync(TOMBSTONE_FILE, JSON.stringify(this.data, null, 2), "utf8");
    } catch (err) {
      console.error(`[tombstones] save failed: ${(err as Error).message}`);
    }
  }

  /** Set of entry ids hidden in the given session. */
  hiddenIds(sessionId: string): Set<string> {
    const m = this.data[sessionId];
    return m ? new Set(Object.keys(m)) : new Set();
  }

  /** Hide an entry; returns the new total count for the session. */
  add(sessionId: string, entryId: string, reason?: string): number {
    if (!this.data[sessionId]) this.data[sessionId] = {};
    this.data[sessionId][entryId] = { ts: new Date().toISOString(), reason };
    this.save();
    return Object.keys(this.data[sessionId]).length;
  }

  /** Restore an entry; returns true if it was present. */
  remove(sessionId: string, entryId: string): boolean {
    if (!this.data[sessionId] || !this.data[sessionId][entryId]) return false;
    delete this.data[sessionId][entryId];
    if (!Object.keys(this.data[sessionId]).length) delete this.data[sessionId];
    this.save();
    return true;
  }

  /** Filter entries through the hidden set. */
  filter(entries: Entry[], sessionId: string): Entry[] {
    const hidden = this.hiddenIds(sessionId);
    if (!hidden.size) return entries;
    return entries.filter((e) => !e.id || !hidden.has(e.id));
  }
}

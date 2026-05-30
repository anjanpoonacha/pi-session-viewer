// src/engine/audit.ts — append-only audit log under ~/.pi/session-viewer/purge-log/.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PURGE_LOG_DIR = join(homedir(), ".pi", "session-viewer", "purge-log");

/** Best-effort: returns the audit file path on success, or null on failure. */
export function writeAuditLog(record: unknown): string | null {
  try {
    mkdirSync(PURGE_LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(PURGE_LOG_DIR, `${stamp}.json`);
    writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
    return file;
  } catch (err) {
    console.error(`[audit] write failed: ${(err as Error).message}`);
    return null;
  }
}

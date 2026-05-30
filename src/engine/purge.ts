// src/engine/purge.ts — whole-session deletion (trash CLI preferred).
//
// Active-window guard: refuse if the session was modified within the last
// 60s — that's almost certainly a live session. Pruning has no such guard
// because pruning never touches the original file; purge does delete it.

import { spawnSync } from "node:child_process";
import { statSync, unlinkSync } from "node:fs";

export const ACTIVE_WINDOW_MS = 60_000;

let _hasTrash: boolean | null = null;
function hasTrashCli(): boolean {
  if (_hasTrash !== null) return _hasTrash;
  const r = spawnSync("command", ["-v", "trash"], { shell: true });
  _hasTrash = r.status === 0;
  return _hasTrash;
}

export type PurgeOutcome =
  | { ok: true; method: "trash" | "unlink"; sizeBytes: number }
  | { ok: false; status: number; error: string };

/** Delete a whole session file. */
export function purgeSession(path: string, opts: { hard?: boolean } = {}): PurgeOutcome {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    return { ok: false, status: 500, error: `stat failed: ${(err as Error).message}` };
  }
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs < ACTIVE_WINDOW_MS) {
    return {
      ok: false,
      status: 409,
      error: `session was modified ${Math.round(ageMs / 1000)}s ago; likely active. Refusing to delete.`,
    };
  }
  const useTrash = hasTrashCli() && !opts.hard;
  try {
    if (useTrash) {
      const r = spawnSync("trash", [path]);
      if (r.status !== 0) {
        return {
          ok: false,
          status: 500,
          error: `trash failed (status ${r.status}); pass ?hard=1 to fall back to unlink`,
        };
      }
      return { ok: true, method: "trash", sizeBytes: stat.size };
    }
    unlinkSync(path);
    return { ok: true, method: "unlink", sizeBytes: stat.size };
  } catch (err) {
    return { ok: false, status: 500, error: (err as Error).message };
  }
}

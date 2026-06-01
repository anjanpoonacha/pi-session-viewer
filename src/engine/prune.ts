// src/engine/prune.ts -- splice-pruning. No placeholder strings.
//
// History
// =======
// v1 (rejected): replaced selected toolCall args with `[elided . X pruned]`. The
// model imitated the placeholder on resume and pi executed destructive
// `write(content="[elided ...]")` calls, clobbering source files.
//
// v2 (replaced by this file): dropped the toolCall and flipped its toolResult
// to a `user` text bubble like `[write call elided . /path . 4.4 KB pruned]`.
// This kept the Anthropic tool_use <-> tool_result pairing valid but the
// placeholder text still entered the model's context on resume -- the user saw
// the bug in session 049ce9ec where the LAST assistant message literally was
// `[write call elided . .../page-019-variance-study.md . 4.4 KB pruned]`.
//
// v3 (this file, splice): no placeholders anywhere. Prune-able items are
// REMOVED from the JSONL. parentId on every survivor is mended to the nearest
// surviving ancestor. Three known cross-id refs are patched
// (compaction.firstKeptEntryId, branch_summary.fromId, label.targetId).
// On resume pi sees a smaller but otherwise authentic history.
//
// Why this is safe -- three facts the design rests on:
//   1. `buildSessionContext()` walks parentId leaf->root only. Anything off the
//      surviving path is invisible to the model. So splicing == parentId
//      reattachment.
//   2. Both Bedrock and Anthropic provider adapters silently SKIP assistant
//      entries with empty `content`, so we don't need a placeholder block to
//      keep stripped entries valid.
//   3. tool_use <-> tool_result pairing is computed at API-conversion time
//      ACROSS THE PATH, not stored in the JSONL. So as long as both halves of
//      every pair are simultaneously present or simultaneously absent on every
//      leaf-to-root path, the API request is well-formed.
//
// References:
//   - design doc: /Users/I548399/.config/pi/oracle-splice-prune-design.md
//   - poisoned snapshot proof: session 049ce9ec-0b2d-46c9-b8f7-4a066a3429a6
//   - session-format spec:
//     ~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md

import { writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Entry,
  GroupedSession,
  ParseResult,
  PruneApplyReport,
  PruneCandidate,
  PruneInventory,
  SessionHeader,
} from "../types.ts";

// Thresholds: candidates below these are considered too small to surface.
const TOOLRESULT_PRUNE_MIN_BYTES = 4 * 1024;
const TOOLCALL_ARG_PRUNE_MIN_BYTES = 4 * 1024;
const THINKING_PRUNE_MIN_BYTES = 256;

/**
 * Detects placeholder strings emitted by old (v1/v2) pruners. Used both for the
 * `isPoisonedSnapshot` flag in `summarize()` and to surface legacy placeholders
 * as `elidedPlaceholder` candidates so users can clean their old snapshots
 * inside the prune UI.
 *
 * Shapes covered (the middot \u00B7 is matched explicitly):
 *   - v1:  [elided ...]                  and  [elided: ...]
 *   - v2:  [<verb> call elided . ...]    e.g. [write call elided . /path . 4.4 KB pruned]
 *   - v2:  [<tool> result elided ...]    e.g. [bash result elided . pruned]
 *   - v2:  [tool result . ... pruned]    (head/tail-truncated tool result)
 *   - v2:  [image . ... pruned]          (image content block placeholder)
 */
export const PLACEHOLDER_PATTERN =
  /\[(?:elided[ :]|\w+ call elided[ :\u00B7]|\w+ result elided\b|tool result \u00B7|image \u00B7)/;

/** Walk the entries and collect every prune-able piece of content. */
export function inventoryPruneCandidates(
  entries: Entry[],
  grouped?: GroupedSession,
): PruneInventory {
  const candidates: PruneCandidate[] = [];
  const totals = {
    image: { count: 0, bytes: 0 },
    thinking: { count: 0, bytes: 0 },
    toolResultText: { count: 0, bytes: 0 },
    toolCallArg: { count: 0, bytes: 0 },
    elidedPlaceholder: { count: 0, bytes: 0 },
  };

  // Map entryId -> 1-based turn index for nicer UI labels.
  const turnByEntryId = new Map<string, number>();
  if (grouped) {
    for (const t of grouped.turns) {
      if (t.user?.id) turnByEntryId.set(t.user.id, t.index + 1);
      for (const a of t.assistants) if (a.entry.id) turnByEntryId.set(a.entry.id, t.index + 1);
    }
  }

  for (const e of entries) {
    if (e.type !== "message" || !e.id) continue;
    const m = e.message;
    if (!m) continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const turnIndex = turnByEntryId.get(e.id);

    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (!c || typeof c !== "object") continue;

      if (c.type === "image" && typeof c.data === "string") {
        const bytes = c.data.length;
        totals.image.count++;
        totals.image.bytes += bytes;
        candidates.push({
          id: `${e.id}:image:${i}`,
          entryId: e.id,
          kind: "image",
          contentIndex: i,
          bytes,
          turnIndex,
          ts: e.timestamp,
          toolName: m.role === "toolResult" ? m.toolName : undefined,
          toolCallId: m.role === "toolResult" ? m.toolCallId : undefined,
          imagePreview: { mimeType: c.mimeType, data: c.data },
          preview: nearbyText(content, i),
        });
        continue;
      }

      if (c.type === "thinking" && typeof c.thinking === "string") {
        // Skip redacted thinking blocks: their `thinkingSignature` payload is opaque
        // and required for replay; we can't surface them as prune candidates.
        if (c.redacted) continue;
        const bytes = c.thinking.length;
        if (bytes < THINKING_PRUNE_MIN_BYTES) continue;
        totals.thinking.count++;
        totals.thinking.bytes += bytes;
        candidates.push({
          id: `${e.id}:thinking:${i}`,
          entryId: e.id,
          kind: "thinking",
          contentIndex: i,
          bytes,
          turnIndex,
          ts: e.timestamp,
          preview: c.thinking.slice(0, 160).replace(/\s+/g, " "),
        });
        continue;
      }

      // Legacy placeholder cleanup: surface text blocks containing v1/v2 prune
      // markers as their own candidate kind. This is checked BEFORE the normal
      // toolResultText branch so an oversized poisoned text block flows into
      // `elidedPlaceholder` (full-pair drop) rather than `toolResultText`.
      if (
        c.type === "text" &&
        typeof c.text === "string" &&
        PLACEHOLDER_PATTERN.test(c.text)
      ) {
        const bytes = c.text.length;
        totals.elidedPlaceholder.count++;
        totals.elidedPlaceholder.bytes += bytes;
        candidates.push({
          id: `${e.id}:elidedPlaceholder:${i}`,
          entryId: e.id,
          kind: "elidedPlaceholder",
          contentIndex: i,
          bytes,
          turnIndex,
          ts: e.timestamp,
          toolName: m.role === "toolResult" ? m.toolName : undefined,
          toolCallId: m.role === "toolResult" ? m.toolCallId : undefined,
          preview: c.text.slice(0, 200).replace(/\s+/g, " "),
        });
        continue;
      }

      if (c.type === "text" && m.role === "toolResult" && typeof c.text === "string") {
        const bytes = c.text.length;
        if (bytes < TOOLRESULT_PRUNE_MIN_BYTES) continue;
        totals.toolResultText.count++;
        totals.toolResultText.bytes += bytes;
        candidates.push({
          id: `${e.id}:toolResultText:${i}`,
          entryId: e.id,
          kind: "toolResultText",
          contentIndex: i,
          bytes,
          turnIndex,
          ts: e.timestamp,
          toolName: m.toolName,
          toolCallId: m.toolCallId,
          preview: c.text.slice(0, 200).replace(/\s+/g, " "),
        });
        continue;
      }

      if (c.type === "toolCall" && c.arguments && typeof c.arguments === "object") {
        for (const [k, v] of Object.entries(c.arguments)) {
          if (typeof v !== "string") continue;
          const bytes = v.length;
          if (bytes < TOOLCALL_ARG_PRUNE_MIN_BYTES) continue;
          totals.toolCallArg.count++;
          totals.toolCallArg.bytes += bytes;
          candidates.push({
            id: `${e.id}:toolCallArg:${i}:${k}`,
            entryId: e.id,
            kind: "toolCallArg",
            contentIndex: i,
            argKey: k,
            bytes,
            turnIndex,
            ts: e.timestamp,
            toolName: c.name,
            toolCallId: c.id,
            preview: `${k}=${v.slice(0, 120).replace(/\s+/g, " ")}`,
          });
        }
      }
    }
  }

  // most recent first -- user almost always wants newest turns at the top
  candidates.sort((a, b) => (b.turnIndex ?? 0) - (a.turnIndex ?? 0));
  return { candidates, totals };
}

function nearbyText(content: any[], imageIndex: number): string | undefined {
  for (const off of [-1, 1]) {
    const j = imageIndex + off;
    if (j < 0 || j >= content.length) continue;
    const t = content[j];
    if (t?.type === "text" && typeof t.text === "string") {
      return t.text.slice(0, 160).replace(/\s+/g, " ");
    }
  }
  return undefined;
}

export class PruneIntegrityError extends Error {
  constructor(message: string, public readonly failures: string[]) {
    super(message);
    this.name = "PruneIntegrityError";
  }
}

/**
 * Splice selected items out of the entry list. Returns the new list plus a
 * report. The original `entries` array is not mutated.
 *
 * Per kind:
 *   - image, thinking: remove just the content block (entry kept iff content is non-empty).
 *   - toolCallArg: remove the toolCall content block AND the matching toolResult entry.
 *   - toolResultText: remove the whole toolResult entry AND the matching toolCall block.
 *   - elidedPlaceholder: remove the offending text block; if the host is a
 *     toolResult the whole pair is dropped (the placeholder body was the only
 *     trace of that result anyway).
 *
 * Then:
 *   - parentId on every survivor is retargeted to the nearest surviving ancestor.
 *   - branch_summary / label / compaction cross-id refs are patched (or the
 *     entry is dropped when no surviving target exists).
 *   - the result is validated structurally; a PruneIntegrityError is thrown on
 *     any failure, leaving the original file untouched.
 */
export function applyPrune(
  entries: Entry[],
  inventory: PruneInventory,
  selectedIds: Set<string>,
): { newEntries: Entry[]; report: PruneApplyReport } {
  const report: PruneApplyReport = {
    removedCount: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    perKind: {
      image: { count: 0, bytes: 0 },
      thinking: { count: 0, bytes: 0 },
      toolResultText: { count: 0, bytes: 0 },
      toolCallArg: { count: 0, bytes: 0 },
      elidedPlaceholder: { count: 0, bytes: 0 },
    },
    splicedToolPairs: 0,
    splicedEntries: 0,
    splicedPairs: [],
  };

  // ---------------------------------------------------------------------------
  // pass 1 -- classify each selection.
  //
  // We end up with three buckets:
  //   * dropContent: per-entry list of content-block indices to delete.
  //   * removeEntry: ids of entries that should disappear in their entirety.
  //   * droppedToolCallIds: tool_use_ids whose entire pair (call + result) goes.
  //
  // Whichever side of a pair the user selected, we add its tool_use_id here so
  // pass 2 can find the OTHER side and queue it for removal.
  // ---------------------------------------------------------------------------
  const dropContent = new Map<string, Set<number>>();
  const removeEntry = new Set<string>();
  const droppedToolCallIds = new Set<string>();
  const droppedToolNames = new Map<string, string | undefined>();

  const addContentDrop = (entryId: string, idx: number) => {
    const set = dropContent.get(entryId) ?? new Set<number>();
    set.add(idx);
    dropContent.set(entryId, set);
  };

  for (const cand of inventory.candidates) {
    if (!selectedIds.has(cand.id)) continue;
    report.removedCount++;
    report.bytesBefore += cand.bytes;
    report.perKind[cand.kind].count++;
    report.perKind[cand.kind].bytes += cand.bytes;

    if (cand.kind === "toolCallArg") {
      // Drop just the toolCall block; pass 2 will remove its toolResult.
      addContentDrop(cand.entryId, cand.contentIndex);
      if (cand.toolCallId) {
        droppedToolCallIds.add(cand.toolCallId);
        droppedToolNames.set(cand.toolCallId, cand.toolName);
      }
    } else if (cand.kind === "toolResultText") {
      // Selecting any toolResult text drops the entire toolResult entry; pass
      // 2 will remove its toolCall block.
      removeEntry.add(cand.entryId);
      if (cand.toolCallId) {
        droppedToolCallIds.add(cand.toolCallId);
        droppedToolNames.set(cand.toolCallId, cand.toolName);
      }
    } else if (cand.kind === "elidedPlaceholder") {
      // Pre-splice pruners injected a single text block in place of a real
      // toolCall or toolResult. If the host is a toolResult, that block is the
      // entire result body -- drop the whole pair. Otherwise drop just the
      // offending text block (the assistant entry's other blocks may be real).
      const host = entries.find((e) => e.id === cand.entryId);
      const role = host?.message?.role;
      if (role === "toolResult") {
        removeEntry.add(cand.entryId);
        if (cand.toolCallId) {
          droppedToolCallIds.add(cand.toolCallId);
          droppedToolNames.set(cand.toolCallId, cand.toolName);
        }
      } else {
        addContentDrop(cand.entryId, cand.contentIndex);
      }
    } else {
      // image / thinking -- single-block drop, no pairing concerns.
      addContentDrop(cand.entryId, cand.contentIndex);
    }
  }

  // ---------------------------------------------------------------------------
  // pass 2 -- walk the entry set once and (a) queue the OTHER half of every
  // dropped tool pair, (b) record metadata for the audit log.
  //
  // For every droppedToolCallId we want:
  //   * the assistant entry's toolCall content block index -> dropContent
  //   * the toolResult entry id                            -> removeEntry
  // ---------------------------------------------------------------------------
  for (const e of entries) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;

    if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      if (droppedToolCallIds.has(m.toolCallId)) {
        if (e.id) removeEntry.add(e.id);
        // Capture toolName from the result side too -- some `toolCallArg`
        // candidates may not have carried it.
        if (!droppedToolNames.get(m.toolCallId) && typeof m.toolName === "string") {
          droppedToolNames.set(m.toolCallId, m.toolName);
        }
      }
      continue;
    }

    if (m.role === "assistant" && Array.isArray(m.content) && e.id) {
      m.content.forEach((c: any, i: number) => {
        if (
          c?.type === "toolCall" &&
          typeof c.id === "string" &&
          droppedToolCallIds.has(c.id)
        ) {
          addContentDrop(e.id!, i);
          if (!droppedToolNames.get(c.id) && typeof c.name === "string") {
            droppedToolNames.set(c.id, c.name);
          }
        }
      });
    }
  }

  // Record paired drops for the audit log (no tool-output content, just the id
  // and the tool name -- consistent with the "no synthetic strings" rule).
  for (const id of droppedToolCallIds) {
    report.splicedToolPairs++;
    report.splicedPairs.push({ toolCallId: id, toolName: droppedToolNames.get(id) });
  }

  // ---------------------------------------------------------------------------
  // pass 3 -- build survivors with content-block filtering. Entries that end up
  // with empty content arrays are queued for full removal in pass 4 (we run a
  // single pass-4 mend afterward; nothing references the empty entries yet).
  // ---------------------------------------------------------------------------
  const stage: Entry[] = [];
  for (const e of entries) {
    if (e.id && removeEntry.has(e.id)) continue;
    const drops = e.id ? dropContent.get(e.id) : undefined;
    if (!drops || drops.size === 0) {
      stage.push(e);
      continue;
    }
    const m = e.message;
    if (!m || !Array.isArray(m.content)) {
      stage.push(e);
      continue;
    }
    const newContent = m.content.filter((_: any, i: number) => !drops.has(i));
    if (newContent.length === 0) {
      // Entry has nothing left -- queue for full removal.
      if (e.id) removeEntry.add(e.id);
      continue;
    }
    const stillHasToolCall = newContent.some((c: any) => c?.type === "toolCall");
    const newMessage =
      m.role === "assistant" && !stillHasToolCall && m.stopReason === "toolUse"
        ? { ...m, content: newContent, stopReason: "stop" }
        : { ...m, content: newContent };
    stage.push({ ...e, message: newMessage });
  }

  // ---------------------------------------------------------------------------
  // pass 4 -- parentId mending.
  //
  // Build an originalParent map (ids -> parentId) BEFORE the new entry list is
  // mutated so chains of consecutive removed entries collapse cleanly via
  // transitive lookup.
  // ---------------------------------------------------------------------------
  const originalParent = new Map<string, string | null>();
  for (const e of entries) {
    if (e.id) originalParent.set(e.id, e.parentId ?? null);
  }
  const nearestSurvivingAncestor = (id: string): string | null => {
    let p = originalParent.get(id) ?? null;
    while (p !== null && removeEntry.has(p)) p = originalParent.get(p) ?? null;
    return p;
  };
  const mended: Entry[] = stage.map((e) => {
    if (e.parentId && removeEntry.has(e.parentId)) {
      return { ...e, parentId: nearestSurvivingAncestor(e.id!) };
    }
    return e;
  });

  // ---------------------------------------------------------------------------
  // pass 5 -- cross-id reference fixes.
  //
  // Walk forward through the original entries to resolve a compaction's
  // firstKeptEntryId to the next surviving descendant. branch_summary and
  // label entries are dropped when their target disappears.
  // ---------------------------------------------------------------------------
  const indexByOriginal = new Map<string, number>();
  entries.forEach((e, i) => {
    if (e.id) indexByOriginal.set(e.id, i);
  });
  const findFirstSurvivingAfter = (deadTargetId: string): string | null => {
    const startIdx = indexByOriginal.get(deadTargetId);
    if (startIdx === undefined) return null;
    for (let i = startIdx; i < entries.length; i++) {
      const e = entries[i];
      if (e.id && !removeEntry.has(e.id)) return e.id;
    }
    return null;
  };

  let droppedCompactions = 0;
  let droppedBranchSummaries = 0;
  let droppedLabels = 0;
  const finalEntries: Entry[] = [];
  for (const s of mended) {
    if (s.type === "branch_summary") {
      const fromId = (s as any).fromId;
      if (typeof fromId === "string" && removeEntry.has(fromId)) {
        droppedBranchSummaries++;
        continue;
      }
    }
    if (s.type === "label") {
      const targetId = (s as any).targetId;
      if (typeof targetId === "string" && removeEntry.has(targetId)) {
        droppedLabels++;
        continue;
      }
    }
    if (s.type === "compaction") {
      const fk = (s as any).firstKeptEntryId;
      if (typeof fk === "string" && removeEntry.has(fk)) {
        const next = findFirstSurvivingAfter(fk);
        if (!next) {
          droppedCompactions++;
          continue;
        }
        finalEntries.push({ ...s, firstKeptEntryId: next });
        continue;
      }
    }
    finalEntries.push(s);
  }

  // Bookkeeping: entries fully removed by selection (does not include cross-ref
  // drops, those are tracked separately above).
  report.splicedEntries =
    removeEntry.size + droppedCompactions + droppedBranchSummaries + droppedLabels;

  // ---------------------------------------------------------------------------
  // pass 6 -- hard validation. Throws on failure so writeSnapshot is never
  // reached with a malformed file. This is the safety net that keeps a
  // future bug from silently producing un-resumable files.
  // ---------------------------------------------------------------------------
  validateSnapshot(finalEntries);

  return { newEntries: finalEntries, report };
}

/** Structural assertions -- see oracle design section 3.1. */
export function validateSnapshot(entries: Entry[]): void {
  const failures: string[] = [];

  // unique ids
  const ids = new Set<string>();
  for (const e of entries) {
    if (!e.id) continue;
    if (ids.has(e.id)) failures.push(`duplicate entry id: ${e.id}`);
    ids.add(e.id);
  }

  // parentIds resolve (null is ok for any number of root entries)
  for (const e of entries) {
    if (!e.id) continue;
    const p = e.parentId ?? null;
    if (p !== null && !ids.has(p)) {
      failures.push(`entry ${e.id} has unresolved parentId: ${p}`);
    }
  }

  // no cycles
  const parentOf = new Map<string, string | null>();
  for (const e of entries) {
    if (e.id) parentOf.set(e.id, e.parentId ?? null);
  }
  for (const startId of ids) {
    const seen = new Set<string>();
    let cur: string | null = startId;
    let steps = 0;
    while (cur !== null && steps < entries.length + 1) {
      if (seen.has(cur)) {
        failures.push(`cycle detected at ${cur}`);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
      steps++;
    }
    if (steps > entries.length) failures.push(`walk from ${startId} exceeded entry count`);
  }

  // tool_use <-> tool_result symmetry on every leaf-to-root path
  const childrenOf = new Map<string | null, string[]>();
  for (const e of entries) {
    if (!e.id) continue;
    const p = e.parentId ?? null;
    const arr = childrenOf.get(p) ?? [];
    arr.push(e.id);
    childrenOf.set(p, arr);
  }
  const leafIds: string[] = [];
  for (const id of ids) if (!childrenOf.get(id)?.length) leafIds.push(id);
  const entryById = new Map<string, Entry>();
  for (const e of entries) if (e.id) entryById.set(e.id, e);

  for (const leaf of leafIds) {
    const calls = new Map<string, number>();
    const results = new Map<string, number>();
    let cur: string | null = leaf;
    while (cur !== null) {
      const e = entryById.get(cur);
      if (!e) break;
      const m = e.message;
      if (m && Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c?.type === "toolCall" && typeof c.id === "string") {
            calls.set(c.id, (calls.get(c.id) ?? 0) + 1);
          }
        }
      }
      if (m && m.role === "toolResult" && typeof m.toolCallId === "string") {
        results.set(m.toolCallId, (results.get(m.toolCallId) ?? 0) + 1);
      }
      cur = parentOf.get(cur) ?? null;
    }
    for (const id of calls.keys()) {
      if ((calls.get(id) ?? 0) !== (results.get(id) ?? 0)) {
        failures.push(
          `leaf ${leaf}: tool_use ${id} has ${calls.get(id)} calls but ${results.get(id) ?? 0} results`,
        );
      }
    }
    for (const id of results.keys()) {
      if (!calls.has(id)) {
        failures.push(`leaf ${leaf}: orphan toolResult.toolCallId ${id} on path`);
      }
    }
  }

  // cross-id refs resolve
  for (const e of entries) {
    if (e.type === "compaction") {
      const fk = (e as any).firstKeptEntryId;
      if (typeof fk === "string" && !ids.has(fk)) {
        failures.push(`compaction ${e.id} firstKeptEntryId ${fk} not found`);
      }
    }
    if (e.type === "branch_summary") {
      const fromId = (e as any).fromId;
      if (typeof fromId === "string" && !ids.has(fromId)) {
        failures.push(`branch_summary ${e.id} fromId ${fromId} not found`);
      }
    }
    if (e.type === "label") {
      const targetId = (e as any).targetId;
      if (typeof targetId === "string" && !ids.has(targetId)) {
        failures.push(`label ${e.id} targetId ${targetId} not found`);
      }
    }
  }

  // no leftover placeholder strings
  for (const e of entries) {
    const blocks = (e.message?.content as any[]) ?? [];
    for (const c of blocks) {
      if (c?.type === "text" && typeof c.text === "string" && PLACEHOLDER_PATTERN.test(c.text)) {
        failures.push(`entry ${e.id ?? "?"}: text content still contains a v1/v2 placeholder string`);
        break;
      }
      if (c?.type === "toolCall" && c.arguments && typeof c.arguments === "object") {
        for (const [k, v] of Object.entries(c.arguments)) {
          if (typeof v === "string" && PLACEHOLDER_PATTERN.test(v)) {
            failures.push(`entry ${e.id ?? "?"}: toolCall arg "${k}" still contains a v1 placeholder string`);
            break;
          }
        }
      }
    }
  }

  if (failures.length) {
    throw new PruneIntegrityError(
      `splice produced an invalid snapshot (${failures.length} failure${failures.length === 1 ? "" : "s"}); refusing to write`,
      failures,
    );
  }
}

/**
 * Write a pruned-snapshot JSONL next to the original. Returns the new path.
 *
 * Important: the snapshot gets a FRESH session id and a `prunedFromSession` field
 * pointing back at the source. Reusing the source's id would cause id-based
 * routing collisions in tools that index sessions by header.id.
 */
export function writeSnapshot(
  sourcePath: string,
  header: SessionHeader | null,
  newEntries: Entry[],
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = basename(sourcePath).replace(/\.jsonl$/, "");
  const outPath = join(dirname(sourcePath), `${stem}.pruned-${stamp}.jsonl`);
  // Construct a new header that preserves cwd + version but disambiguates id.
  const newHeader = header
    ? {
        ...header,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        prunedFromSession: sourcePath,
        prunedFromId: header.id,
      }
    : null;
  const lines: string[] = [];
  if (newHeader) lines.push(JSON.stringify(newHeader));
  for (const e of newEntries) lines.push(JSON.stringify(e));
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  return outPath;
}

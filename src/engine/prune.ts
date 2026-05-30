// src/engine/prune.ts — content-block-level pruning.
//
// The user picks per-item what to drop (images, large tool results, large
// tool-call args, thinking blocks). We replace each selected piece of content
// with a short text placeholder; chain (parentId graph) is unchanged. The
// resulting "snapshot" file is written next to the original — the original
// itself is never modified.

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
  };

  // Map entryId → 1-based turn index for nicer UI labels.
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

  // most recent first — user almost always wants newest turns at the top
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

/**
 * Apply selected drops to a copy of the entries; the chain stays valid.
 * Returns the new entry list plus a report of what was removed.
 *
 * Special handling per kind:
 *  - image, toolResultText: replaced inline with a text placeholder
 *  - thinking: silent drop (avoids text-prefix contamination on replay)
 *  - toolCallArg: drops the ENTIRE toolCall block (replaced with text), AND
 *    neutralises the matching toolResult message by converting its role from
 *    "toolResult" to "user" with a placeholder body. This is required — leaving
 *    the toolCall in place (with placeholder args) trained the model to replay
 *    the placeholder as a real tool call (e.g. write(content="[elided …]")) and
 *    pi executed it, clobbering source files. See oracle review run e8b2e7f2.
 *
 *    Anthropic strictly pairs tool_use ↔ tool_result. Removing the call without
 *    also removing the result would leave an orphan tool_result that the API
 *    rejects on resume. The role-flip keeps the chain valid and skips the
 *    tool_use_id binding requirement entirely.
 */
export function applyPrune(
  entries: Entry[],
  inventory: PruneInventory,
  selectedIds: Set<string>,
): { newEntries: Entry[]; report: PruneApplyReport; droppedToolCalls: { id: string; name?: string; replacedWith: string }[] } {
  const byEntry = new Map<string, PruneCandidate[]>();
  for (const cand of inventory.candidates) {
    if (!selectedIds.has(cand.id)) continue;
    const list = byEntry.get(cand.entryId) ?? [];
    list.push(cand);
    byEntry.set(cand.entryId, list);
  }

  const report: PruneApplyReport = {
    removedCount: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    perKind: {
      image: { count: 0, bytes: 0 },
      thinking: { count: 0, bytes: 0 },
      toolResultText: { count: 0, bytes: 0 },
      toolCallArg: { count: 0, bytes: 0 },
    },
  };

  // Pass 1: collect toolCallIds whose owning call will be dropped, so the
  // matching toolResult entries can be neutralised in pass 2.
  const droppedToolCallIds = new Set<string>();
  const droppedToolNames = new Map<string, string>();
  const droppedToolCalls: { id: string; name?: string; replacedWith: string }[] = [];
  for (const cands of byEntry.values()) {
    for (const c of cands) {
      if (c.kind === "toolCallArg" && c.toolCallId) {
        droppedToolCallIds.add(c.toolCallId);
        if (c.toolName) droppedToolNames.set(c.toolCallId, c.toolName);
      }
    }
  }

  const callPlaceholder = (call: any, totalBytes: number): { type: "text"; text: string } => {
    const name = call?.name ?? "tool";
    const path = call?.arguments?.path;
    const cmd = typeof call?.arguments?.command === "string"
      ? call.arguments.command.replace(/\s+/g, " ").slice(0, 60)
      : undefined;
    const hint = path ? ` · ${path}` : cmd ? ` · $ ${cmd}` : "";
    return {
      type: "text",
      text: `[${name} call elided${hint} · ${formatBytes(totalBytes)} pruned]`,
    };
  };

  const resultPlaceholder = (toolName: string | undefined, originalTimestamp: any) => ({
    role: "user" as const,
    content: [
      {
        type: "text" as const,
        text: `[${toolName ?? "tool"} result elided · pruned]`,
      },
    ],
    timestamp: originalTimestamp ?? Date.now(),
  });

  // Pass 2: walk entries and apply transforms.
  const newEntries: Entry[] = entries.map((e) => {
    // (1) toolResult entries whose call is being dropped → neutralise.
    if (
      e.type === "message" &&
      e.message?.role === "toolResult" &&
      typeof e.message.toolCallId === "string" &&
      droppedToolCallIds.has(e.message.toolCallId)
    ) {
      const toolName = droppedToolNames.get(e.message.toolCallId) ?? e.message.toolName;
      return { ...e, message: resultPlaceholder(toolName, e.message.timestamp) };
    }

    // (2) per-content-block transformation for selected entries.
    const drops = e.id ? byEntry.get(e.id) : undefined;
    if (!drops || !drops.length) return e;
    const m = e.message;
    if (!m || !Array.isArray(m.content)) return e;

    const dropsByIndex = new Map<number, PruneCandidate[]>();
    for (const d of drops) {
      const list = dropsByIndex.get(d.contentIndex) ?? [];
      list.push(d);
      dropsByIndex.set(d.contentIndex, list);
    }

    const newContent: any[] = [];
    m.content.forEach((c: any, idx: number) => {
      const matches = dropsByIndex.get(idx);
      if (!matches) {
        newContent.push(c);
        return;
      }

      // Whole-toolCall drop: any toolCallArg candidate against a toolCall block.
      const isToolCallDrop =
        c?.type === "toolCall" && matches.some((d) => d.kind === "toolCallArg");

      if (isToolCallDrop) {
        const totalBytes = matches
          .filter((d) => d.kind === "toolCallArg")
          .reduce((n, d) => n + d.bytes, 0);
        for (const d of matches) {
          if (d.kind !== "toolCallArg") continue;
          report.removedCount++;
          report.bytesBefore += d.bytes;
          report.perKind.toolCallArg.count++;
          report.perKind.toolCallArg.bytes += d.bytes;
        }
        const replacement = callPlaceholder(c, totalBytes);
        report.bytesAfter += replacement.text.length;
        if (typeof c?.id === "string") {
          droppedToolCalls.push({
            id: c.id,
            name: c.name,
            replacedWith: replacement.text,
          });
        }
        newContent.push(replacement);
        return;
      }

      // Other kinds: existing per-block semantics.
      let working: any = c;
      let dropped = false;
      for (const d of matches) {
        if (d.kind === "toolCallArg") continue; // handled above
        report.removedCount++;
        report.bytesBefore += d.bytes;
        if (d.kind === "thinking") {
          report.bytesAfter += 0;
          report.perKind[d.kind].count++;
          report.perKind[d.kind].bytes += d.bytes;
          dropped = true;
          break;
        }
        const replacement = buildReplacement(working, d);
        report.bytesAfter += replacementBytes(replacement, d);
        report.perKind[d.kind].count++;
        report.perKind[d.kind].bytes += d.bytes;
        working = replacement;
      }
      if (!dropped) newContent.push(working);
    });

    return { ...e, message: { ...m, content: newContent } };
  });

  return { newEntries, report, droppedToolCalls };
}

function buildReplacement(c: any, d: PruneCandidate): any {
  if (d.kind === "image") {
    return { type: "text", text: `[image · ${formatBytes(d.bytes)} pruned]` };
  }
  // thinking is silent-dropped in applyPrune — not handled here.
  if (d.kind === "toolResultText") {
    const txt = String(c?.text ?? "");
    const head = txt.slice(0, 256);
    const tail = txt.slice(-256);
    return {
      type: "text",
      text: `${head}\n\n… [tool result · ${formatBytes(d.bytes)} pruned] …\n\n${tail}`,
    };
  }
  // toolCallArg is handled inline in applyPrune (drops the whole call); not here.
  return c;
}

function replacementBytes(replacement: any, _d: PruneCandidate): number {
  // toolCallArg no longer reaches this path (handled inline in applyPrune).
  return typeof replacement?.text === "string" ? replacement.text.length : 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
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

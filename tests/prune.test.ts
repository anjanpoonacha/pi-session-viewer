// tests/prune.test.ts -- contract tests for splice-pruning (v3).
//
// Contract:
//   1. Selected items are REMOVED from the JSONL. No placeholder text appears
//      anywhere in the output.
//   2. tool_use <-> tool_result symmetry holds on every leaf-to-root path.
//   3. parentId on every survivor resolves; chains of consecutive removed
//      entries collapse to the nearest surviving ancestor.
//   4. Cross-id refs (compaction.firstKeptEntryId, branch_summary.fromId,
//      label.targetId) either resolve to a surviving entry or the carrying
//      entry is dropped.
//   5. Legacy v1/v2 placeholder strings can be cleaned via the new
//      `elidedPlaceholder` candidate kind.
//   6. validateSnapshot() throws PruneIntegrityError on any structural failure.

import { describe, expect, test } from "bun:test";
import {
  applyPrune,
  inventoryPruneCandidates,
  validateSnapshot,
  PruneIntegrityError,
  PLACEHOLDER_PATTERN,
} from "../src/engine/prune.ts";
import { groupIntoTurns } from "../src/parser/turns.ts";
import type { Entry } from "../src/types.ts";

// ---- fixtures ----

const BIG = "x".repeat(8 * 1024); // 8 KB string -- above TOOLCALL_ARG_PRUNE_MIN_BYTES

/** Single user/assistant/toolResult triple with one big-arg toolCall. */
function callPair(): Entry[] {
  return [
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-05-30T10:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "write a big file" }],
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-05-30T10:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "toolu_01",
            name: "write",
            arguments: { path: "/tmp/foo.ts", content: BIG },
          },
        ],
        model: "anthropic--claude-4.7-opus",
        stopReason: "toolUse",
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: "2026-05-30T10:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "toolu_01",
        toolName: "write",
        content: [{ type: "text", text: "Successfully wrote 8 KB" }],
        isError: false,
        timestamp: 1780133002000,
      },
    },
  ];
}

/** A second turn after the spliced pair, so we have a survivor whose parentId
 * needs mending to the entry BEFORE the dropped pair. */
function withTrailingTurn(): Entry[] {
  return [
    ...callPair(),
    {
      type: "message",
      id: "u2",
      parentId: "r1",
      timestamp: "2026-05-30T10:00:10.000Z",
      message: { role: "user", content: [{ type: "text", text: "next thing" }] },
    },
    {
      type: "message",
      id: "a2",
      parentId: "u2",
      timestamp: "2026-05-30T10:00:11.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "anthropic--claude-4.7-opus",
        stopReason: "stop",
      },
    },
  ];
}

// ---- splice contract ----

describe("applyPrune -- splice (v3) contract", () => {
  test("toolCallArg selection removes BOTH the toolCall block AND its toolResult entry", () => {
    const entries = withTrailingTurn();
    const grouped = groupIntoTurns(entries);
    const inv = inventoryPruneCandidates(entries, grouped);
    const cand = inv.candidates.find((c) => c.kind === "toolCallArg")!;
    expect(cand).toBeDefined();

    const { newEntries, report } = applyPrune(entries, inv, new Set([cand.id]));

    // a1 had only the one toolCall block -- entry should be GONE entirely.
    expect(newEntries.find((e) => e.id === "a1")).toBeUndefined();
    // r1 (the matching toolResult) is also GONE.
    expect(newEntries.find((e) => e.id === "r1")).toBeUndefined();
    // u1 survives and is now u2's nearest surviving ancestor (a1, r1 both gone).
    const u2 = newEntries.find((e) => e.id === "u2")!;
    expect(u2.parentId).toBe("u1");
    // report bookkeeping.
    expect(report.splicedToolPairs).toBe(1);
    expect(report.splicedPairs[0].toolCallId).toBe("toolu_01");
    expect(report.splicedPairs[0].toolName).toBe("write");
  });

  test("the spliced output contains NO placeholder strings (the v3 hard rule)", () => {
    const entries = callPair();
    const inv = inventoryPruneCandidates(entries, groupIntoTurns(entries));
    const cand = inv.candidates.find((c) => c.kind === "toolCallArg")!;

    const { newEntries } = applyPrune(entries, inv, new Set([cand.id]));

    for (const e of newEntries) {
      const blocks = (e.message?.content as any[]) ?? [];
      for (const c of blocks) {
        if (c?.type === "text" && typeof c.text === "string") {
          expect(PLACEHOLDER_PATTERN.test(c.text)).toBe(false);
        }
        if (c?.type === "toolCall" && c.arguments) {
          for (const v of Object.values(c.arguments)) {
            if (typeof v === "string") expect(PLACEHOLDER_PATTERN.test(v)).toBe(false);
          }
        }
      }
    }
  });

  test("toolResultText selection drops the WHOLE pair (not just the body)", () => {
    const entries = withTrailingTurn();
    // Force a toolResultText candidate by inflating the result body above 4 KB.
    (entries[2].message.content[0] as any).text = "X".repeat(8 * 1024);
    const inv = inventoryPruneCandidates(entries, groupIntoTurns(entries));
    const cand = inv.candidates.find((c) => c.kind === "toolResultText");
    expect(cand).toBeDefined();

    const { newEntries } = applyPrune(entries, inv, new Set([cand!.id]));

    expect(newEntries.find((e) => e.id === "a1")).toBeUndefined();
    expect(newEntries.find((e) => e.id === "r1")).toBeUndefined();
    const u2 = newEntries.find((e) => e.id === "u2")!;
    expect(u2.parentId).toBe("u1");
  });

  test("multi-toolCall assistant entry: only the selected call is dropped, siblings survive", () => {
    const entries: Entry[] = [
      callPair()[0], // u1
      {
        type: "message",
        id: "aMulti",
        parentId: "u1",
        timestamp: "2026-05-30T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc_keep", name: "bash", arguments: { command: "ls" } },
            { type: "toolCall", id: "tc_drop", name: "write", arguments: { path: "/tmp/x", content: BIG } },
          ],
          model: "anthropic--claude-4.7-opus",
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        id: "rKeep",
        parentId: "aMulti",
        timestamp: "2026-05-30T10:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tc_keep",
          toolName: "bash",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "rDrop",
        parentId: "rKeep",
        timestamp: "2026-05-30T10:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tc_drop",
          toolName: "write",
          content: [{ type: "text", text: "wrote" }],
          isError: false,
          timestamp: 2,
        },
      },
    ];
    const inv = inventoryPruneCandidates(entries, groupIntoTurns(entries));
    const cand = inv.candidates.find((c) => c.kind === "toolCallArg" && c.toolCallId === "tc_drop")!;

    const { newEntries } = applyPrune(entries, inv, new Set([cand.id]));

    const aMulti = newEntries.find((e) => e.id === "aMulti")!;
    expect(aMulti).toBeDefined();
    const blocks = aMulti.message.content as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("toolCall");
    expect(blocks[0].id).toBe("tc_keep");
    // tc_keep's result is preserved, tc_drop's is gone.
    expect(newEntries.find((e) => e.id === "rKeep")).toBeDefined();
    expect(newEntries.find((e) => e.id === "rDrop")).toBeUndefined();
  });

  test("legacy elidedPlaceholder candidate cleans v2-shaped poisoned text", () => {
    const entries: Entry[] = [
      callPair()[0],
      {
        type: "message",
        id: "aLegacy",
        parentId: "u1",
        timestamp: "2026-05-30T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "[write call elided \u00b7 /tmp/foo.ts \u00b7 4.4 KB pruned]",
            },
          ],
          model: "anthropic--claude-4.7-opus",
          stopReason: "stop",
        },
      },
    ];
    const inv = inventoryPruneCandidates(entries, groupIntoTurns(entries));
    const cand = inv.candidates.find((c) => c.kind === "elidedPlaceholder");
    expect(cand).toBeDefined();

    const { newEntries } = applyPrune(entries, inv, new Set([cand!.id]));

    // The assistant entry's only block was the placeholder -- the entry is removed.
    expect(newEntries.find((e) => e.id === "aLegacy")).toBeUndefined();
    // u1 survives.
    expect(newEntries.find((e) => e.id === "u1")).toBeDefined();
  });

  test("empty selection is a no-op", () => {
    const entries = withTrailingTurn();
    const inv = inventoryPruneCandidates(entries, groupIntoTurns(entries));

    const { newEntries, report } = applyPrune(entries, inv, new Set());

    expect(report.removedCount).toBe(0);
    expect(report.splicedToolPairs).toBe(0);
    expect(newEntries).toEqual(entries);
  });

  test("parentId chain stays valid after a multi-pair splice", () => {
    const entries = withTrailingTurn();
    const inv = inventoryPruneCandidates(entries, groupIntoTurns(entries));
    const cand = inv.candidates.find((c) => c.kind === "toolCallArg")!;
    const { newEntries } = applyPrune(entries, inv, new Set([cand.id]));

    const ids = new Set(newEntries.map((e) => e.id));
    for (const e of newEntries) {
      if (e.parentId == null) continue;
      expect(ids.has(e.parentId)).toBe(true);
    }
  });
});

// ---- validateSnapshot ----

describe("validateSnapshot -- structural assertions", () => {
  test("rejects orphan toolResult on a leaf path", () => {
    const entries: Entry[] = [
      {
        type: "message",
        id: "u",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "message",
        id: "r",
        parentId: "u",
        message: {
          role: "toolResult",
          toolCallId: "missing",
          toolName: "bash",
          content: [{ type: "text", text: "x" }],
          isError: false,
          timestamp: 1,
        },
      },
    ];
    expect(() => validateSnapshot(entries)).toThrow(PruneIntegrityError);
  });

  test("rejects unresolved parentId", () => {
    const entries: Entry[] = [
      {
        type: "message",
        id: "a",
        parentId: "ghost",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ];
    expect(() => validateSnapshot(entries)).toThrow(PruneIntegrityError);
  });

  test("rejects leftover placeholder strings in text content", () => {
    const entries: Entry[] = [
      {
        type: "message",
        id: "a",
        parentId: null,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "[write call elided \u00b7 /x \u00b7 1 KB pruned]" }],
          stopReason: "stop",
        },
      },
    ];
    expect(() => validateSnapshot(entries)).toThrow(PruneIntegrityError);
  });

  test("accepts a clean linear session", () => {
    expect(() => validateSnapshot(callPair())).not.toThrow();
  });
});

// ---- regression: 049ce9ec-style placeholder ----

describe("regression -- session 049ce9ec contamination shape", () => {
  test("PLACEHOLDER_PATTERN catches the exact shape that broke 049ce9ec", () => {
    const text = "[write call elided \u00b7 /Users/x/spikes/results/page-019-variance-study.md \u00b7 4.4 KB pruned]";
    expect(PLACEHOLDER_PATTERN.test(text)).toBe(true);
  });
  test("PLACEHOLDER_PATTERN catches v1 [elided ...] strings too", () => {
    expect(PLACEHOLDER_PATTERN.test("[elided \u00b7 8.2 KB pruned]")).toBe(true);
    expect(PLACEHOLDER_PATTERN.test("[elided: 8.2 KB pruned]")).toBe(true);
  });
});

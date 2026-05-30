// tests/prune.test.ts — regression tests for the contamination-loop fix.
//
// History: Earlier the pruner replaced a toolCall's argument string with text like
//   `[elided · 8.2 KB pruned]`. That string lived inside `arguments.content`, the
//   model imitated it on resume, and pi executed `write(content="[elided …]")`
//   clobbering source files. The fix (oracle + reviewer convergence, run e8b2e7f2)
//   drops the entire toolCall block AND neutralizes the matching toolResult by
//   flipping its role to "user" with a placeholder text body.
//
// These tests pin that contract so a future "cleanup" can't quietly re-introduce
// the contamination shape.

import { describe, expect, test } from "bun:test";
import { applyPrune, inventoryPruneCandidates } from "../src/engine/prune.ts";
import { groupIntoTurns } from "../src/parser/turns.ts";
import type { Entry } from "../src/types.ts";

// ---- fixture ----

const BIG = "x".repeat(8 * 1024); // 8 KB string — above TOOLCALL_ARG_PRUNE_MIN_BYTES

function makeFixture(): Entry[] {
  // Minimal session: assistant emits a write toolCall with a big content arg,
  // followed by the matching toolResult.
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
        timestamp: 1780133002000, // unix ms — matches pi's real toolResult shape
      },
    },
  ];
}

// ---- tests ----

describe("applyPrune — toolCallArg contamination fix", () => {
  test("pruning a toolCall arg drops the entire toolCall block (replaced with text)", () => {
    const entries = makeFixture();
    const grouped = groupIntoTurns(entries);
    const inv = inventoryPruneCandidates(entries, grouped);
    const cand = inv.candidates.find((c) => c.kind === "toolCallArg");
    expect(cand).toBeDefined();

    const { newEntries } = applyPrune(entries, inv, new Set([cand!.id]));

    const assistantMsg = newEntries.find((e) => e.id === "a1")!.message!;
    const blocks = assistantMsg.content as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text"); // toolCall block is GONE, replaced by text
    expect(blocks[0].text).toContain("write call elided");
    expect(blocks[0].text).toContain("/tmp/foo.ts"); // path hint preserved
    expect(blocks[0].text).toContain("pruned");
  });

  test("matching toolResult message has its role flipped to user with placeholder text", () => {
    const entries = makeFixture();
    const grouped = groupIntoTurns(entries);
    const inv = inventoryPruneCandidates(entries, grouped);
    const cand = inv.candidates.find((c) => c.kind === "toolCallArg")!;

    const { newEntries } = applyPrune(entries, inv, new Set([cand.id]));

    const resultEntry = newEntries.find((e) => e.id === "r1")!;
    const resultMsg = resultEntry.message!;
    expect(resultMsg.role).toBe("user"); // role flip — NOT toolResult anymore
    expect(resultMsg.content).toEqual([
      { type: "text", text: expect.stringContaining("write result elided") },
    ]);
    // Original timestamp preserved (oracle's call — message.timestamp, the unix-ms
    // field pi's real toolResults carry, NOT the entry-level ISO timestamp)
    expect(resultMsg.timestamp).toBe(1780133002000);
  });

  test("no remaining toolCall arguments contain the [elided …] contamination string", () => {
    // The exact contamination signature: any toolCall whose arguments include
    // a string matching the placeholder pattern. Even one such occurrence is
    // a regression — the model will imitate it on resume.
    const entries = makeFixture();
    const grouped = groupIntoTurns(entries);
    const inv = inventoryPruneCandidates(entries, grouped);
    const cand = inv.candidates.find((c) => c.kind === "toolCallArg")!;

    const { newEntries } = applyPrune(entries, inv, new Set([cand.id]));

    let leaks = 0;
    for (const e of newEntries) {
      const blocks = (e.message?.content as any[]) ?? [];
      for (const c of blocks) {
        if (c?.type !== "toolCall") continue;
        for (const v of Object.values(c.arguments ?? {})) {
          if (typeof v === "string" && /\[elided/.test(v)) leaks++;
        }
      }
    }
    expect(leaks).toBe(0);
  });

  test("audit report includes droppedToolCalls with id, name, and replacement text", () => {
    const entries = makeFixture();
    const grouped = groupIntoTurns(entries);
    const inv = inventoryPruneCandidates(entries, grouped);
    const cand = inv.candidates.find((c) => c.kind === "toolCallArg")!;

    const { droppedToolCalls } = applyPrune(entries, inv, new Set([cand.id]));

    expect(droppedToolCalls).toHaveLength(1);
    expect(droppedToolCalls[0]).toMatchObject({
      id: "toolu_01",
      name: "write",
    });
    expect(droppedToolCalls[0].replacedWith).toContain("write call elided");
  });

  test("parentId chain stays valid after the prune", () => {
    const entries = makeFixture();
    const grouped = groupIntoTurns(entries);
    const inv = inventoryPruneCandidates(entries, grouped);
    const cand = inv.candidates.find((c) => c.kind === "toolCallArg")!;

    const { newEntries } = applyPrune(entries, inv, new Set([cand.id]));

    // every non-root parentId must point at an entry that exists in newEntries
    const ids = new Set(newEntries.map((e) => e.id));
    for (const e of newEntries) {
      if (e.parentId && e.parentId !== null) {
        expect(ids.has(e.parentId)).toBe(true);
      }
    }
  });

  test("entries not selected by user are untouched", () => {
    const entries = makeFixture();
    const grouped = groupIntoTurns(entries);
    const inv = inventoryPruneCandidates(entries, grouped);

    // Apply with empty selection — nothing should change.
    const { newEntries, report, droppedToolCalls } = applyPrune(entries, inv, new Set());

    expect(droppedToolCalls).toHaveLength(0);
    expect(report.removedCount).toBe(0);
    expect(newEntries).toEqual(entries);
  });
});

// src/parser/turns.ts — group flat entries into the logical turn tree.
//
// Pi's parentId chain is just "previous entry," so it gives us a chain.
// The real tree comes from:
//   1. user message starts a turn
//   2. assistants until the next user message belong to that turn
//   3. assistant.content[] holds inline thinking/text/toolCall blocks
//   4. toolResult entries reference toolCall.id via toolCallId
// We derive (1)–(4) here — pure, deterministic, < 1ms on 551-entry sessions.

import type {
  AssistantBlock,
  BranchInfo,
  ContentBlock,
  Entry,
  GroupedSession,
  ResolvedToolCall,
  Turn,
  TurnAside,
} from "../types.ts";

export function groupIntoTurns(entries: Entry[]): GroupedSession {
  // Pass 1: index toolResults by toolCallId so assistants can resolve their calls.
  const resultByCallId = new Map<string, Entry>();
  for (const e of entries) {
    if (e.type === "message" && e.message?.role === "toolResult" && e.message.toolCallId) {
      resultByCallId.set(e.message.toolCallId, e);
    }
  }
  const consumedToolResultIds = new Set<string>();

  function buildAssistantBlock(e: Entry): AssistantBlock {
    const m = e.message;
    const content: ContentBlock[] = Array.isArray(m?.content) ? m.content : [];
    const thinking: { type: "thinking"; thinking: string }[] = [];
    const text: { type: "text"; text: string }[] = [];
    const toolCalls: ResolvedToolCall[] = [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "thinking") thinking.push(c as any);
      else if (c.type === "text") text.push(c as any);
      else if (c.type === "toolCall") {
        const result = resultByCallId.get((c as any).id);
        if (result) consumedToolResultIds.add((c as any).id);
        toolCalls.push({
          call: { id: (c as any).id, name: (c as any).name, arguments: (c as any).arguments },
          result,
        });
      }
    }
    return {
      entry: e,
      model: m?.model,
      costUsd: m?.usage?.cost?.total ?? 0,
      totalTokens: m?.usage?.totalTokens ?? 0,
      thinking,
      text,
      toolCalls,
      raw: content,
      stopReason: m?.stopReason,
      errorMessage: m?.errorMessage,
    };
  }

  function asideOf(e: Entry): TurnAside | null {
    if (e.type === "message") {
      const role = e.message?.role;
      if (role === "toolResult") return null; // handled below as orphan check
      if (role === "custom") return { kind: "custom", entry: e };
      return null;
    }
    if (e.type === "compaction") return { kind: "compaction", entry: e };
    if (e.type === "branch_summary") return { kind: "branch_summary", entry: e };
    if (e.type === "model_change") return { kind: "model_change", entry: e };
    if (e.type === "thinking_level_change") return { kind: "thinking_level_change", entry: e };
    if (e.type === "label") return { kind: "label", entry: e };
    if (e.type === "session_info") return { kind: "session_info", entry: e };
    if (e.type === "custom") return { kind: "custom", entry: e };
    if (e.type === "custom_message") return { kind: "custom_message", entry: e };
    return { kind: "unknown", entry: e };
  }

  const turns: Turn[] = [];
  const preludeAsides: TurnAside[] = [];
  let cur: Turn | null = null;
  let turnIndex = 0;

  function startTurn(e: Entry | undefined): Turn {
    return {
      index: turnIndex++,
      user: e,
      preludeAsides: [],
      assistants: [],
      trailingAsides: [],
      startedAt: e?.timestamp,
      endedAt: e?.timestamp,
      totalCostUsd: 0,
      totalTokens: 0,
    };
  }

  for (const e of entries) {
    const m = e.type === "message" ? e.message : undefined;

    if (m?.role === "user") {
      if (cur) turns.push(cur);
      cur = startTurn(e);
      continue;
    }
    if (m?.role === "assistant") {
      if (!cur) cur = startTurn(undefined);
      const block = buildAssistantBlock(e);
      cur.assistants.push(block);
      cur.totalCostUsd += block.costUsd;
      cur.totalTokens += block.totalTokens;
      if (e.timestamp) cur.endedAt = e.timestamp;
      continue;
    }
    if (m?.role === "toolResult") {
      const callId = m.toolCallId;
      if (callId && consumedToolResultIds.has(callId)) continue;
      const aside: TurnAside = { kind: "orphan_tool_result", entry: e };
      if (cur) cur.trailingAsides.push(aside);
      else preludeAsides.push(aside);
      continue;
    }
    const aside = asideOf(e);
    if (!aside) continue;
    if (cur) cur.trailingAsides.push(aside);
    else preludeAsides.push(aside);
  }
  if (cur) turns.push(cur);

  return { preludeAsides, turns };
}

/**
 * Detect actual branches (rare — only from /tree or /fork).
 * A branch exists when an entry's parentId points to something OTHER than the
 * immediately preceding entry, OR when a branch_summary entry appears.
 */
export function detectBranches(entries: Entry[]): BranchInfo {
  const branchPoints: string[] = [];
  const branchSummaries: string[] = [];
  let prevId: string | null = null;
  for (const e of entries) {
    if (e.type === "branch_summary" && e.id) branchSummaries.push(e.id);
    if (e.parentId !== undefined && e.parentId !== null && prevId !== null && e.parentId !== prevId) {
      if (e.id) branchPoints.push(e.id);
    }
    if (e.id) prevId = e.id;
  }
  return {
    hasBranches: branchPoints.length > 0 || branchSummaries.length > 0,
    branchPointEntryIds: branchPoints,
    branchSummaryEntryIds: branchSummaries,
  };
}

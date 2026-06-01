// src/types.ts — domain types shared across modules.

// --- session entries ---

export type SessionHeader = {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
};

export type Entry = {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: any;
  [key: string]: any;
};

export type ParseResult = {
  header: SessionHeader | null;
  entries: Entry[];
  partial: boolean;
  errors: string[];
};

// --- list view ---

export type Summary = {
  id: string;
  path: string;
  name?: string;
  project: string;
  cwd?: string;
  timestamp: string;
  mtime: number;
  messageCount: number;
  lastModel?: string;
  totalCostUsd: number;
  totalTokens: number;
  sizeBytes: number;
  partial: boolean;
  parentSession?: string;
  prunedFromSession?: string;
  prunedFromId?: string;
  /** True when the file name follows the *.pruned-<ISO>.jsonl pattern. */
  isPrunedSnapshot: boolean;
  /**
   * True when this snapshot was produced by a buggy pre-fix pruner that left
   * `[elided …]` placeholder strings inside toolCall arguments. Resuming such
   * a session causes the model to imitate the placeholder pattern and emit
   * destructive tool calls. Detect-and-warn only — no auto-clean.
   */
  isPoisonedSnapshot: boolean;
  // facets for filtering & visual tags
  toolNames: string[];
  hasImages: boolean;
  hasErrors: boolean;
  hasDiffs: boolean;
  intercomPeers: string[];
  isSubagent: boolean;
  hasIntercom: boolean;
};

// --- turn-tree (the *logical* tree pi sessions actually have) ---

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: any }
  | { type: "image"; data: string; mimeType?: string }
  | { type: string; [k: string]: any };

export type ResolvedToolCall = {
  call: { id: string; name: string; arguments: any };
  result?: Entry;
};

export type AssistantBlock = {
  entry: Entry;
  model?: string;
  costUsd: number;
  totalTokens: number;
  thinking: { type: "thinking"; thinking: string }[];
  text: { type: "text"; text: string }[];
  toolCalls: ResolvedToolCall[];
  raw: ContentBlock[];
  stopReason?: string;
  errorMessage?: string;
};

export type TurnAside =
  | { kind: "compaction"; entry: Entry }
  | { kind: "branch_summary"; entry: Entry }
  | { kind: "model_change"; entry: Entry }
  | { kind: "thinking_level_change"; entry: Entry }
  | { kind: "label"; entry: Entry }
  | { kind: "session_info"; entry: Entry }
  | { kind: "custom"; entry: Entry }
  | { kind: "custom_message"; entry: Entry }
  | { kind: "orphan_tool_result"; entry: Entry }
  | { kind: "unknown"; entry: Entry };

export type Turn = {
  index: number;
  user?: Entry;
  preludeAsides: TurnAside[];
  assistants: AssistantBlock[];
  trailingAsides: TurnAside[];
  startedAt?: string;
  endedAt?: string;
  totalCostUsd: number;
  totalTokens: number;
};

export type GroupedSession = {
  preludeAsides: TurnAside[];
  turns: Turn[];
};

export type BranchInfo = {
  hasBranches: boolean;
  branchPointEntryIds: string[];
  branchSummaryEntryIds: string[];
};

// --- prune ---

export type PruneCandidate = {
  id: string; // <entryId>:<kind>:<contentIndex>[:<argKey>]
  entryId: string;
  /**
   * - image / thinking: drop just the content block.
   * - toolCallArg: drop the entire toolCall block AND its paired toolResult
   *   entry (the JSONL stays Anthropic tool_use ↔ tool_result symmetric).
   * - toolResultText: same — selecting any toolResult text block drops the
   *   whole call/result pair. Head/tail truncation is no longer offered:
   *   any text we keep would itself be authored placeholder content.
   * - elidedPlaceholder: legacy. Pre-splice pruners injected synthetic strings
   *   like `[write call elided · /path · 4.4 KB pruned]` into text blocks.
   *   Selecting one of these drops the offending text block (and full pair if
   *   it sits on a toolResult), so old snapshots can be cleaned in the same
   *   UI without manual JSONL surgery.
   */
  kind:
    | "image"
    | "thinking"
    | "toolResultText"
    | "toolCallArg"
    | "elidedPlaceholder";
  contentIndex: number;
  argKey?: string;
  bytes: number;
  turnIndex?: number;
  ts?: string;
  toolName?: string;
  toolCallId?: string;
  preview?: string;
  imagePreview?: { mimeType?: string; data: string };
};

export type PruneInventory = {
  candidates: PruneCandidate[];
  totals: {
    image: { count: number; bytes: number };
    thinking: { count: number; bytes: number };
    toolResultText: { count: number; bytes: number };
    toolCallArg: { count: number; bytes: number };
    elidedPlaceholder: { count: number; bytes: number };
  };
};

export type PruneApplyReport = {
  removedCount: number;
  bytesBefore: number;
  bytesAfter: number;
  perKind: Record<string, { count: number; bytes: number }>;
  /** Number of toolCall ↔ toolResult pairs spliced (full removal, no placeholder). */
  splicedToolPairs: number;
  /** Number of full entries removed (assistant entries emptied by splice, toolResult pairs, dangling cross-refs). */
  splicedEntries: number;
  /** Tool calls whose pair was spliced — kept for the audit log only. No payload, no replacement text. */
  splicedPairs: { toolCallId: string; toolName?: string }[];
};

// --- forest (subagent tree) ---

export type ForestNode = {
  summary: Summary;
  children: ForestNode[];
};

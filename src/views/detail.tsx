/** @jsxImportSource hono/jsx */
// src/views/detail.tsx — single-session detail page (turns view + flat fallback).

import type { BranchInfo, Entry, GroupedSession, Summary, Turn } from "../types.ts";
import { AsideRow, AssistantBlockView, EntryPurgeButton, UserTurnMessage } from "./blocks.tsx";
import { extractText, fmtBytes, fmtCost, fmtTime, shortId, uniqueWithCount } from "./format.ts";

export const SessionDetail = (props: {
  summary: Summary;
  flatEntries: Entry[];
  partial: boolean;
  errors: string[];
  view: "flat" | "turns";
  grouped?: GroupedSession;
  branches?: BranchInfo;
  tombstoneCount?: number;
}) => (
  <div class="detail">
    <div class="detail-header">
      <a href="/" class="back">← all sessions</a>
      <h1>{props.summary.name ?? shortId(props.summary.id)}</h1>
      <div class="meta">
        <span>{props.summary.cwd ?? "(unknown cwd)"}</span>
        <span class="dim">{fmtTime(props.summary.timestamp)}</span>
        <span>{props.summary.messageCount} messages</span>
        <span>{fmtCost(props.summary.totalCostUsd)}</span>
        <span>{props.summary.totalTokens.toLocaleString()} tokens</span>
        <span class="dim">{fmtBytes(props.summary.sizeBytes)}</span>
        {props.summary.lastModel ? <span class="dim">last: {props.summary.lastModel}</span> : null}
      </div>
      <div class="view-toggle">
        <a href={`/s/${props.summary.id}?view=turns`} class={props.view === "turns" ? "active" : ""}>turn tree</a>
        <a href={`/s/${props.summary.id}?view=flat`} class={props.view === "flat" ? "active" : ""}>flat</a>
        {props.branches?.hasBranches ? (
          <span class="branch-warn">
            ⚠ {props.branches.branchPointEntryIds.length} branch point
            {props.branches.branchPointEntryIds.length === 1 ? "" : "s"}
            {props.branches.branchSummaryEntryIds.length
              ? `, ${props.branches.branchSummaryEntryIds.length} branch summary${props.branches.branchSummaryEntryIds.length === 1 ? "" : "ies"}`
              : ""}
          </span>
        ) : null}
        <a
          href={`/s/${props.summary.id}/prune`}
          class="prune-link-btn"
          title="Pick which images / tool outputs / thinking blocks to drop and write a new pruned session file"
        >
          ✂ prune snapshot…
        </a>
        <button
          class="purge-btn detail-purge"
          type="button"
          title="Move this session to trash"
          data-session-id={props.summary.id}
          data-session-size={fmtBytes(props.summary.sizeBytes)}
        >
          🗑 purge
        </button>
      </div>
      {props.summary.parentSession ? (
        <div class="parent-link dim">
          ↰ subagent child of <code>{props.summary.parentSession}</code>
        </div>
      ) : null}
      {props.summary.isPrunedSnapshot ? (
        <div class="parent-link snapshot-banner">
          ✂ pruned snapshot
          {props.summary.prunedFromSession ? (
            <>
              {" of "}
              <code>{props.summary.prunedFromSession}</code>
            </>
          ) : null}
        </div>
      ) : null}
      {props.summary.isPoisonedSnapshot ? (
        <div class="poison-banner">
          ☠ <strong>contaminated snapshot</strong> — this file was produced by an earlier
          buggy version of the pruner that left <code>[elided …]</code> placeholder
          strings inside tool-call arguments. Resuming this session causes the model
          to imitate the pattern and emit destructive tool calls (e.g.
          <code>write(content="[elided …]")</code> overwriting source files).
          <br />
          <strong>Do NOT resume this snapshot.</strong> Re-prune from the original
          source session and use the new snapshot instead.
        </div>
      ) : null}
      {props.partial ? (
        <div class="warn">
          ⚠ partial session ({props.errors.length} parse error{props.errors.length === 1 ? "" : "s"})
        </div>
      ) : null}
      {props.tombstoneCount ? (
        <div class="info">
          🪦 {props.tombstoneCount} entr{props.tombstoneCount === 1 ? "y" : "ies"} hidden by tombstones
          (the JSONL file is unchanged)
        </div>
      ) : null}
    </div>
    {props.view === "turns" && props.grouped ? (
      <TurnsView grouped={props.grouped} branches={props.branches} sessionId={props.summary.id} />
    ) : (
      <FlatView entries={props.flatEntries} sessionId={props.summary.id} />
    )}
  </div>
);

const TurnsView = ({
  grouped,
  branches,
  sessionId,
}: {
  grouped: GroupedSession;
  branches?: BranchInfo;
  sessionId: string;
}) => (
  <div class="turns">
    {grouped.preludeAsides.length ? (
      <div class="prelude">
        <div class="prelude-label dim small">setup</div>
        <ul class="asides">
          {grouped.preludeAsides.map((a) => (
            <AsideRow aside={a} sessionId={sessionId} />
          ))}
        </ul>
      </div>
    ) : null}
    {grouped.turns.map((t) => (
      <TurnSection turn={t} branches={branches} sessionId={sessionId} />
    ))}
  </div>
);

const TurnSection = ({
  turn,
  branches,
  sessionId,
}: {
  turn: Turn;
  branches?: BranchInfo;
  sessionId: string;
}) => {
  const userText = turn.user ? extractText(turn.user.message?.content) : "";
  const userPreview = userText.slice(0, 200).replace(/\s+/g, " ");
  const totalCalls = turn.assistants.reduce((n, a) => n + a.toolCalls.length, 0);
  const allTools = turn.assistants.flatMap((a) => a.toolCalls.map((c) => c.call.name));
  const toolBadges = uniqueWithCount(allTools);
  const turnId = turn.user?.id ?? `turn-${turn.index}`;
  const isBranchPoint = !!turn.user?.id && branches?.branchPointEntryIds.includes(turn.user.id);
  return (
    <details class={`turn ${isBranchPoint ? "branch-point" : ""}`} open={turn.index < 3} id={`turn-${turnId}`}>
      <summary class="turn-summary">
        <span class="turn-num dim">turn {turn.index + 1}</span>
        <span class="turn-user">{userPreview || <span class="dim">(no user message)</span>}</span>
        <span class="turn-stats dim small">
          {turn.assistants.length}× assistant
          {totalCalls ? ` · ${totalCalls} tool call${totalCalls === 1 ? "" : "s"}` : ""}
          {turn.totalCostUsd ? ` · ${fmtCost(turn.totalCostUsd)}` : ""}
        </span>
        {toolBadges.length ? (
          <span class="turn-tools">
            {toolBadges.slice(0, 5).map(({ name, count }) => (
              <span class="tool-badge">
                {name}
                {count > 1 ? <span class="badge-count">×{count}</span> : null}
              </span>
            ))}
            {toolBadges.length > 5 ? <span class="tool-badge dim">+{toolBadges.length - 5}</span> : null}
          </span>
        ) : null}
        {isBranchPoint ? <span class="branch-tag">branch point</span> : null}
      </summary>
      <div class="turn-body">
        {turn.user ? <UserTurnMessage entry={turn.user} sessionId={sessionId} /> : null}
        {turn.assistants.map((a) => (
          <AssistantBlockView block={a} sessionId={sessionId} />
        ))}
        {turn.trailingAsides.length ? (
          <ul class="asides">
            {turn.trailingAsides.map((aside) => (
              <AsideRow aside={aside} sessionId={sessionId} />
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
};

// Flat: chronological list with collapsible asides (debug view).
const FlatView = ({ entries, sessionId }: { entries: Entry[]; sessionId: string }) => (
  <ul class="asides">
    {entries.map((e) => (
      <FlatEntry entry={e} sessionId={sessionId} />
    ))}
  </ul>
);

const FlatEntry = ({ entry, sessionId }: { entry: Entry; sessionId: string }) => {
  // Reuse the AsideRow shape — same expand/collapse semantics.
  const lead =
    entry.type === "message"
      ? entry.message?.role ?? "message"
      : entry.type;
  return (
    <li class={`aside aside-${entry.type}`} id={`block-${entry.id ?? "x"}`}>
      <details>
        <summary>
          <span class="aside-kind">{lead}</span>
          <span class="aside-lead dim">{shortId(entry.id ?? "?")}</span>
          <span class="dim small">{fmtTime(entry.timestamp)}</span>
          <EntryPurgeButton sessionId={sessionId} entryId={entry.id} label="hide" />
        </summary>
        <div class="aside-body">
          <pre class="raw">{JSON.stringify(entry, null, 2).slice(0, 8 * 1024)}</pre>
        </div>
      </details>
    </li>
  );
};

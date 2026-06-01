/** @jsxImportSource hono/jsx */
// src/views/prune.tsx — prune planning page (per-item checkboxes).

import type { PruneCandidate, PruneInventory, Summary } from "../types.ts";
import { basenamePath, fmtBytes, fmtTime } from "./format.ts";

export const PrunePage = ({
  summary,
  inventory,
}: {
  summary: Summary;
  inventory: PruneInventory;
}) => {
  const byKind: Record<string, PruneCandidate[]> = {
    image: [],
    thinking: [],
    toolResultText: [],
    toolCallArg: [],
    elidedPlaceholder: [],
  };
  for (const c of inventory.candidates) byKind[c.kind].push(c);

  const totalCount = inventory.candidates.length;
  const totalBytes =
    inventory.totals.image.bytes +
    inventory.totals.thinking.bytes +
    inventory.totals.toolResultText.bytes +
    inventory.totals.toolCallArg.bytes +
    inventory.totals.elidedPlaceholder.bytes;

  return (
    <div class="prune-page">
      <div class="detail-header">
        <a href={`/s/${summary.id}`} class="back">← back to session</a>
        <h1>Prune snapshot · {summary.name ?? summary.id.slice(0, 8)}</h1>
        <div class="meta">
          <span>{summary.cwd ?? "(unknown cwd)"}</span>
          <span class="dim">{fmtTime(summary.timestamp)}</span>
          <span>{summary.messageCount} messages</span>
          <span class="dim">{fmtBytes(summary.sizeBytes)} on disk</span>
        </div>
        <div class="prune-explain">
          The original file <code>{basenamePath(summary.path)}</code> will <strong>not</strong> be modified.
          A new file <code>{basenamePath(summary.path).replace(/\.jsonl$/, "")}.pruned-{"<timestamp>"}.jsonl</code>
          {" "}will be written next to it with the selected items <strong>removed entirely</strong> (no placeholder text).
          parentId is mended automatically so pi can <code>--session</code> the new file directly.
        </div>
      </div>

      <form id="prune-form" method="post" action={`/api/session/${summary.id}/prune`}>
        <div class="prune-toolbar" id="prune-toolbar">
          <span class="prune-summary" id="prune-summary">
            Select items to drop. {totalCount} candidates · {fmtBytes(totalBytes)} reclaimable.
          </span>
          <span class="prune-quick">
            <button type="button" class="quick-btn quick-clean" data-quick="all-elided">clean legacy placeholders</button>
            <button type="button" class="quick-btn" data-quick="all-images">select all images</button>
            <button type="button" class="quick-btn" data-quick="last-5-images">keep last 5 images, drop rest</button>
            <button type="button" class="quick-btn" data-quick="all-bash">all bash &gt; 8 KB</button>
            <button type="button" class="quick-btn" data-quick="all-thinking">all thinking</button>
            <button type="button" class="quick-btn" data-quick="all-toolargs">all huge tool args</button>
            <button type="button" class="quick-btn quick-clear" data-quick="clear">clear</button>
          </span>
        </div>

        {byKind.elidedPlaceholder.length ? (
          <PruneSection
            title={`⚠ Legacy elided placeholders (${inventory.totals.elidedPlaceholder.count})`}
            subtitle={`${fmtBytes(inventory.totals.elidedPlaceholder.bytes)} total · left over from old pruners; selecting drops the offending text or its tool pair`}
            kind="elidedPlaceholder"
            candidates={byKind.elidedPlaceholder}
          />
        ) : null}

        {byKind.image.length ? (
          <PruneSection
            title={`🖼 Images (${inventory.totals.image.count})`}
            subtitle={`${fmtBytes(inventory.totals.image.bytes)} total`}
            kind="image"
            candidates={byKind.image}
          />
        ) : null}

        {byKind.toolResultText.length ? (
          <PruneSection
            title={`📜 Tool results > 4 KB (${inventory.totals.toolResultText.count}) — entire pair dropped`}
            subtitle={`${fmtBytes(inventory.totals.toolResultText.bytes)} total`}
            kind="toolResultText"
            candidates={byKind.toolResultText}
          />
        ) : null}

        {byKind.toolCallArg.length ? (
          <PruneSection
            title={`📥 Tool calls with large args > 4 KB (${inventory.totals.toolCallArg.count}) — entire pair dropped`}
            subtitle={`${fmtBytes(inventory.totals.toolCallArg.bytes)} total`}
            kind="toolCallArg"
            candidates={byKind.toolCallArg}
          />
        ) : null}

        {byKind.thinking.length ? (
          <PruneSection
            title={`💭 Thinking blocks (${inventory.totals.thinking.count})`}
            subtitle={`${fmtBytes(inventory.totals.thinking.bytes)} total`}
            kind="thinking"
            candidates={byKind.thinking}
          />
        ) : null}

        <div class="prune-confirm-bar">
          <span class="prune-running-total" id="prune-running-total">
            0 of {totalCount} selected · 0 B
          </span>
          <a href={`/s/${summary.id}`} class="cancel-link">Cancel</a>
          <button type="submit" class="confirm-prune-btn" id="confirm-prune-btn" disabled>
            Create pruned snapshot →
          </button>
        </div>
      </form>

      <script src="/static/prune.js" defer></script>
    </div>
  );
};

const PruneSection = ({
  title,
  subtitle,
  kind,
  candidates,
}: {
  title: string;
  subtitle: string;
  kind: string;
  candidates: PruneCandidate[];
}) => (
  <details class={`prune-section prune-section-${kind}`} open>
    <summary class="prune-section-summary">
      <span class="caret">▸</span>
      <span class="prune-section-title">{title}</span>
      <span class="dim small">{subtitle}</span>
    </summary>
    <div class="prune-section-actions">
      <button type="button" class="quick-btn small" data-section-select={kind}>select all</button>
      <button type="button" class="quick-btn small" data-section-clear={kind}>clear</button>
    </div>
    <ul class="prune-list">
      {candidates.map((c) => (
        <PruneItem cand={c} />
      ))}
    </ul>
  </details>
);

const PruneItem = ({ cand }: { cand: PruneCandidate }) => (
  <li class={`prune-item prune-item-${cand.kind}`} data-kind={cand.kind} data-bytes={String(cand.bytes)}>
    <label>
      <input type="checkbox" name="selectedIds" value={cand.id} class="prune-cb" />
      <span class="prune-item-meta">
        <span class="prune-turn dim">{cand.turnIndex ? `turn ${cand.turnIndex}` : "—"}</span>
        {cand.toolName ? <span class="prune-tool">{cand.toolName}</span> : null}
        <span class="prune-bytes">{fmtBytes(cand.bytes)}</span>
        <span class="prune-ts dim small">{fmtTime(cand.ts)}</span>
      </span>
      {cand.kind === "image" && cand.imagePreview ? (
        <span class="prune-image-row">
          <img
            class="prune-thumb"
            src={`data:${cand.imagePreview.mimeType ?? "image/png"};base64,${cand.imagePreview.data}`}
            alt=""
          />
          {cand.preview ? <span class="prune-preview">{cand.preview}</span> : null}
        </span>
      ) : (
        <span class="prune-preview">
          {cand.preview ?? <span class="dim">(no preview)</span>}
        </span>
      )}
    </label>
  </li>
);

/** @jsxImportSource hono/jsx */
// src/views/blocks.tsx — per-entry rendering used by both detail views.
//
// Inline entry-purge button surfaces on hover; the actual click is handled by
// /static/sessions.js via data-* attributes (no inline onclick — JSX would
// entity-escape it).

import type { AssistantBlock, ContentBlock, Entry, ResolvedToolCall, TurnAside } from "../types.ts";
import { DiffBlock, extractDiff } from "./diff.tsx";
import { extractText, fmtCost, fmtTime, shortId, truncate } from "./format.ts";

const TRUNC = 4096; // 4 KB cap for tool/bash output text

export const EntryPurgeButton = ({
  sessionId,
  entryId,
  label,
}: {
  sessionId: string;
  entryId?: string;
  label: string;
}) => {
  if (!entryId) return null;
  return (
    <button
      class="entry-purge-btn"
      type="button"
      title="Hide this entry from the viewer (reversible; the JSONL file is unchanged)"
      data-session-id={sessionId}
      data-entry-id={entryId}
      data-original-label={`🪦 ${label}`}
    >
      🪦 {label}
    </button>
  );
};

export const UserTurnMessage = ({ entry, sessionId }: { entry: Entry; sessionId: string }) => {
  const m = entry.message;
  return (
    <div class="block user-block" id={`block-${entry.id ?? "x"}`}>
      <div class="block-header">
        <span class="block-role">user</span>
        <span class="dim small">{fmtTime(entry.timestamp)}</span>
        <EntryPurgeButton sessionId={sessionId} entryId={entry.id} label="hide message" />
      </div>
      <pre class="text">{extractText(m?.content)}</pre>
      <ImageThumbs content={m?.content} />
    </div>
  );
};

export const AssistantBlockView = ({
  block,
  sessionId,
}: {
  block: AssistantBlock;
  sessionId: string;
}) => {
  return (
    <div
      class={`block assistant-block ${block.errorMessage ? "has-error" : ""}`}
      id={`block-${block.entry.id ?? "x"}`}
    >
      <div class="block-header">
        <span class="block-role">assistant</span>
        <span class="dim small">
          {block.model ?? "?"}
          {block.costUsd ? ` · ${fmtCost(block.costUsd)}` : ""}
          {block.totalTokens ? ` · ${block.totalTokens.toLocaleString()} tok` : ""}
          {block.stopReason ? ` · stop=${block.stopReason}` : ""}
          {block.entry.timestamp ? ` · ${fmtTime(block.entry.timestamp)}` : ""}
        </span>
        <EntryPurgeButton sessionId={sessionId} entryId={block.entry.id} label="hide message" />
      </div>
      {block.thinking.map((t) => (
        <details class="thinking">
          <summary>💭 thinking</summary>
          <pre class="text">{t.thinking}</pre>
        </details>
      ))}
      {block.text.map((t) => (
        <pre class="text assistant-text">{t.text}</pre>
      ))}
      {block.toolCalls.length ? (
        <ul class="toolcall-list">
          {block.toolCalls.map((tc) => (
            <ToolCallWithResult tc={tc} />
          ))}
        </ul>
      ) : null}
      {block.errorMessage ? <div class="error">{block.errorMessage}</div> : null}
    </div>
  );
};

const ToolCallWithResult = ({ tc }: { tc: ResolvedToolCall }) => {
  const argsPreview = oneLineArgsLite(tc.call.name, tc.call.arguments);
  const isError = tc.result?.message?.isError === true;
  return (
    <li class={`toolcall-item ${isError ? "is-error" : ""} ${tc.result ? "" : "unresolved"}`}>
      <details>
        <summary class="toolcall-summary">
          <span class="caret">▸</span>
          <span class="tool-icon">🛠</span>
          <span class="tool-name">{tc.call.name}</span>
          <span class="tool-args dim">{argsPreview}</span>
          {tc.result ? null : <span class="unresolved-tag">no result</span>}
          {isError ? <span class="error-tag">error</span> : null}
        </summary>
        <div class="toolcall-body">
          <details>
            <summary class="dim small">arguments</summary>
            <pre class="raw">{JSON.stringify(tc.call.arguments ?? {}, null, 2)}</pre>
          </details>
          {tc.result ? <ToolResultInline entry={tc.result} /> : (
            <div class="dim small">(no toolResult emitted yet)</div>
          )}
        </div>
      </details>
    </li>
  );
};

const ToolResultInline = ({ entry }: { entry: Entry }) => {
  const m = entry.message;
  const text = extractText(m?.content);
  const { text: shown, truncated } = truncate(text, TRUNC);
  const images = collectImages(m?.content);
  const diff = extractDiff(m?.details);
  return (
    <div class={`toolresult-inline ${m?.isError ? "is-error" : ""}`}>
      <div class="dim small">
        result ← {m?.toolCallId ? shortId(m.toolCallId) : "?"}
        {m?.isError ? " · ERROR" : ""}
        {entry.timestamp ? ` · ${fmtTime(entry.timestamp)}` : ""}
        {images.length ? ` · ${images.length} image${images.length === 1 ? "" : "s"}` : ""}
        {diff ? " · diff available" : ""}
      </div>
      {diff ? <DiffBlock diff={diff} /> : null}
      {images.length ? <ImageGallery images={images} /> : null}
      {shown ? <pre class="text">{shown}</pre> : null}
      {truncated ? <div class="trunc">… truncated to {TRUNC} bytes</div> : null}
      {m?.details && !diff ? (
        <details>
          <summary class="dim small">details</summary>
          <pre class="raw">{JSON.stringify(m.details, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
};

// ---- entry-type asides (compaction / model_change / custom / etc.) ----

export const AsideRow = ({ aside, sessionId }: { aside: TurnAside; sessionId: string }) => {
  const e = aside.entry;
  return (
    <li class={`aside aside-${aside.kind}`} id={`block-${e.id ?? "x"}`}>
      <details>
        <summary>
          <span class="aside-kind">{labelForAside(aside)}</span>
          <span class="aside-lead">{leadForAside(aside)}</span>
          <span class="dim small">{fmtTime(e.timestamp)}</span>
          <EntryPurgeButton sessionId={sessionId} entryId={e.id} label="hide" />
        </summary>
        <div class="aside-body">
          <ExpandedBody entry={e} />
        </div>
      </details>
    </li>
  );
};

function labelForAside(a: TurnAside): string {
  switch (a.kind) {
    case "compaction": return "compaction";
    case "branch_summary": return "branch summary";
    case "model_change": return "model change";
    case "thinking_level_change": return "thinking level";
    case "label": return "label";
    case "session_info": return "session info";
    case "custom": return "custom";
    case "custom_message": return "custom message";
    case "orphan_tool_result": return "orphan tool result";
    case "unknown": return "unknown";
  }
}

function leadForAside(a: TurnAside): string {
  const e = a.entry;
  if (a.kind === "compaction") return `${e.tokensBefore ?? "?"} tokens summarized`;
  if (a.kind === "branch_summary") return `from ${shortId(e.fromId ?? "?")}`;
  if (a.kind === "model_change") return `→ ${e.provider ?? "?"}/${e.modelId ?? "?"}`;
  if (a.kind === "thinking_level_change") return `→ ${e.thinkingLevel ?? "?"}`;
  if (a.kind === "label") return `${e.label ?? "(cleared)"} on ${shortId(e.targetId ?? "?")}`;
  if (a.kind === "session_info") return e.name ?? "";
  if (a.kind === "custom" || a.kind === "custom_message") return `customType: ${e.customType ?? "?"}`;
  if (a.kind === "orphan_tool_result") return `${e.message?.toolName ?? "?"}`;
  return e.type;
}

const ExpandedBody = ({ entry }: { entry: Entry }) => {
  if (entry.type === "message" && entry.message) {
    const m = entry.message;
    if (m.role === "user") return <UserBody msg={m} />;
    if (m.role === "toolResult") return <ToolResultInline entry={entry} />;
    if (m.role === "custom") return <CustomBody data={m} />;
    return <UnknownBody entry={entry} />;
  }
  if (entry.type === "compaction") return <CompactionBody entry={entry} />;
  if (entry.type === "branch_summary") return <BranchSummaryBody entry={entry} />;
  if (entry.type === "model_change") return <div class="body small dim">model → {entry.provider}/{entry.modelId}</div>;
  if (entry.type === "thinking_level_change") return <div class="body small dim">thinking level → {entry.thinkingLevel}</div>;
  if (entry.type === "label") return (
    <div class="body small">
      🔖 <strong>{entry.label ?? "(cleared)"}</strong> on <code>{shortId(entry.targetId ?? "?")}</code>
    </div>
  );
  if (entry.type === "session_info") return <div class="body small">name set to <strong>{entry.name}</strong></div>;
  if (entry.type === "custom" || entry.type === "custom_message") return <CustomBody data={entry} />;
  return <UnknownBody entry={entry} />;
};

const UserBody = ({ msg }: { msg: any }) => (
  <div class="body user-body">
    <pre class="text">{extractText(msg.content)}</pre>
    <ImageThumbs content={msg.content} />
  </div>
);

const CompactionBody = ({ entry }: { entry: any }) => (
  <div class="body compaction-body">
    <div class="dim small">
      compacted before <code>{shortId(entry.firstKeptEntryId ?? "?")}</code> · tokens before:{" "}
      {entry.tokensBefore?.toLocaleString?.() ?? entry.tokensBefore ?? "?"}
    </div>
    <pre class="text">{entry.summary ?? ""}</pre>
  </div>
);

const BranchSummaryBody = ({ entry }: { entry: any }) => (
  <div class="body branch-body">
    <div class="dim small">summary of branch from <code>{shortId(entry.fromId ?? "?")}</code></div>
    <pre class="text">{entry.summary ?? ""}</pre>
  </div>
);

const CustomBody = ({ data }: { data: any }) => (
  <div class="body custom-body">
    <div class="dim small">customType: {data.customType ?? "?"}</div>
    <pre class="raw">{JSON.stringify(data.data ?? data.content ?? data.details ?? {}, null, 2)}</pre>
  </div>
);

const UnknownBody = ({ entry }: { entry: Entry }) => (
  <div class="body unknown-body">
    <div class="warn small">unknown entry type: {entry.type}</div>
    <pre class="raw">{JSON.stringify(entry, null, 2)}</pre>
  </div>
);

// ---- images ----

const ImageThumbs = ({ content }: { content: any }) => {
  const imgs = collectImages(content);
  if (!imgs.length) return null;
  return <ImageGallery images={imgs} />;
};

const ImageGallery = ({ images }: { images: { mimeType?: string; data: string }[] }) => (
  <details class="image-gallery" open={images.length <= 3}>
    <summary class="dim small">
      🖼 {images.length} image{images.length === 1 ? "" : "s"}
    </summary>
    <div class="thumbs">
      {images.map((img) => (
        <a
          href={`data:${img.mimeType ?? "image/png"};base64,${img.data}`}
          target="_blank"
          rel="noopener"
          class="thumb-link"
        >
          <img class="thumb" src={`data:${img.mimeType ?? "image/png"};base64,${img.data}`} alt="(image)" />
        </a>
      ))}
    </div>
  </details>
);

function collectImages(content: any): { mimeType?: string; data: string }[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: ContentBlock) => c?.type === "image" && typeof (c as any).data === "string")
    .map((c: any) => ({ mimeType: c.mimeType, data: c.data }));
}

function oneLineArgsLite(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  const candidates: Record<string, string[]> = {
    bash: ["command"],
    read: ["path"],
    edit: ["path"],
    write: ["path"],
    grep: ["pattern", "path"],
    glob: ["pattern"],
  };
  const keys = candidates[toolName] ?? Object.keys(args);
  for (const k of keys) {
    const v = (args as any)[k];
    if (typeof v === "string") return v.length > 100 ? v.slice(0, 100) + "…" : v;
  }
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v);
      return s.length > 100 ? s.slice(0, 100) + "…" : `${k}=${s}`;
    }
  }
  return "";
}

/** @jsxImportSource hono/jsx */
// src/views/list.tsx — index page: filter bar + forest + flat fallback.

import type { ForestNode, Summary } from "../types.ts";
import { fmtBytes, fmtCost, relativeTime, shortId } from "./format.ts";

export const SessionList = (props: {
  groups: { project: string; sessions: Summary[] }[];
  forest: ForestNode[];
  view: "forest" | "flat";
  totalCount: number;
  totalAll: number;
  filterQuery: string;
  availableTools: string[];
}) => (
  <div class="list">
    <div class="list-header">
      <h1>
        {props.totalCount} sessions
        {props.totalCount !== props.totalAll ? <span class="dim small"> of {props.totalAll}</span> : null}
      </h1>
      <span class="dim">
        {props.view === "forest" ? "subagent forest" : "flat by project"} · sorted by mtime
      </span>
    </div>
    <FilterBar query={props.filterQuery} availableTools={props.availableTools} view={props.view} />
    {props.view === "forest" ? (
      <ul class="forest">
        {props.forest.map((node) => (
          <ForestEntry node={node} depth={0} />
        ))}
      </ul>
    ) : (
      props.groups.map((g) => (
        <section class="group">
          <h2 class="group-title">{g.project}</h2>
          <ul class="rows">
            {g.sessions.map((s) => (
              <SessionRow s={s} />
            ))}
          </ul>
        </section>
      ))
    )}
  </div>
);

const FilterBar = ({
  query,
  availableTools,
  view,
}: {
  query: string;
  availableTools: string[];
  view: "forest" | "flat";
}) => (
  <form class="filter-bar" method="get" action="/">
    <input
      type="text"
      name="q"
      placeholder="search — try: has:image  tool:edit  tool:bash  errors  partial  subagent  intercom  cwd:manga"
      value={query}
      class="filter-input"
      autofocus
    />
    <input type="hidden" name="view" value={view} />
    <button type="submit" class="filter-btn">filter</button>
    {query ? <a class="filter-clear" href={`/?view=${view}`}>clear</a> : null}
    <span class="filter-toggle">
      <a href={`/?view=forest${query ? `&q=${encodeURIComponent(query)}` : ""}`} class={view === "forest" ? "active" : ""}>
        forest
      </a>
      <a href={`/?view=flat${query ? `&q=${encodeURIComponent(query)}` : ""}`} class={view === "flat" ? "active" : ""}>
        flat
      </a>
    </span>
    <details class="filter-help">
      <summary class="dim small">filter syntax</summary>
      <div class="filter-help-body">
        <div><code>has:image</code> &nbsp; sessions containing any image content</div>
        <div><code>has:diff</code> &nbsp; sessions with edit/patch results</div>
        <div><code>errors</code> &nbsp; toolResult.isError or assistant stop=error</div>
        <div><code>partial</code> &nbsp; sessions with parse errors</div>
        <div><code>subagent</code> &nbsp; sessions with parentSession header</div>
        <div><code>intercom</code> &nbsp; sessions with intercom_* custom entries</div>
        <div><code>tool:&lt;name&gt;</code> &nbsp; e.g. <code>tool:edit</code> <code>tool:bash</code></div>
        <div><code>cwd:&lt;substr&gt;</code> &nbsp; substring match on cwd</div>
        <div><code>peer:&lt;substr&gt;</code> &nbsp; intercom peer name (substring)</div>
        <div class="dim">all filters AND together; bare words match name/cwd/id/model</div>
        {availableTools.length ? (
          <div class="avail-tools">
            <span class="dim">tools in corpus:</span>{" "}
            {availableTools.map((t) => (
              <code class="avail-tool">{t}</code>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  </form>
);

const SessionRow = ({ s, depth = 0 }: { s: Summary; depth?: number }) => (
  <li
    class={`row ${s.partial ? "partial" : ""}`}
    id={`row-${s.id}`}
    style={depth ? `padding-left: ${depth * 22}px;` : ""}
  >
    <a href={`/s/${s.id}`} class="row-link">
      <span class="when">{relativeTime(s.mtime)}</span>
      <span class="name">{s.name ?? <span class="dim">{shortId(s.id)}</span>}</span>
      <span class="msgs">{s.messageCount} msg</span>
      <span class="model dim">{s.lastModel ?? "—"}</span>
      <span class="cost">{fmtCost(s.totalCostUsd)}</span>
      <span class="size dim">{fmtBytes(s.sizeBytes)}</span>
      <span class="facets">
        {s.hasImages ? <span class="facet-tag tag-image" title="contains images">🖼</span> : null}
        {s.hasDiffs ? <span class="facet-tag tag-diff" title="contains diffs">±</span> : null}
        {s.hasErrors ? <span class="facet-tag tag-error" title="contains errors">!</span> : null}
        {s.hasIntercom ? <span class="facet-tag tag-intercom" title="intercom traffic">⇄</span> : null}
        {s.partial ? <span class="facet-tag tag-partial" title="parse errors">⚠</span> : null}
        {s.parentSession ? <span class="facet-tag tag-child" title="subagent child">↰</span> : null}
        {s.isPrunedSnapshot ? <span class="facet-tag tag-snapshot" title="pruned snapshot">✂</span> : null}
        {s.isPoisonedSnapshot ? <span class="facet-tag tag-poison" title="contaminated by pre-fix pruner — do not resume">☠</span> : null}
      </span>
    </a>
    <button
      class="purge-btn"
      type="button"
      title="Move this session to trash"
      data-session-id={s.id}
      data-session-size={fmtBytes(s.sizeBytes)}
    >
      🗑 purge
    </button>
  </li>
);

const ForestEntry = ({ node, depth }: { node: ForestNode; depth: number }) => (
  <>
    <SessionRow s={node.summary} depth={depth} />
    {node.children.length ? (
      <ul class="forest-children">
        {node.children.map((c) => (
          <ForestEntry node={c} depth={depth + 1} />
        ))}
      </ul>
    ) : null}
  </>
);

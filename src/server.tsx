/** @jsxImportSource hono/jsx */
// src/server.tsx — Hono routes only. All logic lives in engine/* and views/*.

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono } from "hono";

import { writeAuditLog } from "./engine/audit.ts";
import { applyFilter, parseFilter } from "./engine/filter.ts";
import { buildForest } from "./engine/forest.ts";
import { applyPrune, inventoryPruneCandidates, writeSnapshot } from "./engine/prune.ts";
import { ACTIVE_WINDOW_MS, purgeSession } from "./engine/purge.ts";
import { SessionStore } from "./engine/store.ts";
import { TombstoneStore } from "./engine/tombstones.ts";
import { detectBranches, groupIntoTurns } from "./parser/turns.ts";
import { Layout } from "./views/layout.tsx";
import { SessionList } from "./views/list.tsx";
import { SessionDetail } from "./views/detail.tsx";
import { PrunePage } from "./views/prune.tsx";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(HERE); // src/ → project root

function clientFile(name: string): string {
  return join(PROJECT_ROOT, "client", name);
}

export function buildApp(opts: { sessionsDir: string }) {
  const store = new SessionStore(opts.sessionsDir);
  const tombstones = new TombstoneStore();
  const app = new Hono();

  // ---- request logging ----
  app.use("*", async (c, next) => {
    const t0 = performance.now();
    await next();
    const ms = (performance.now() - t0).toFixed(1);
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  });

  // ---- static assets ----
  const STATIC: Record<string, { path: string; contentType: string }> = {
    "/styles.css": { path: clientFile("styles.css"), contentType: "text/css; charset=utf-8" },
    "/static/sessions.js": { path: clientFile("sessions.js"), contentType: "application/javascript; charset=utf-8" },
    "/static/prune.js": { path: clientFile("prune.js"), contentType: "application/javascript; charset=utf-8" },
  };
  for (const [route, file] of Object.entries(STATIC)) {
    app.get(route, (c) => {
      try {
        const body = readFileSync(file.path, "utf8");
        c.header("Content-Type", file.contentType);
        return c.body(body);
      } catch {
        return c.text("not found", 404);
      }
    });
  }

  // ---- pages ----

  app.get("/", async (c) => {
    const summaries = await store.refresh();
    const filter = parseFilter(c.req.query("q") ?? "");
    const filtered = summaries.filter((s) => applyFilter(s, filter));
    const forest = buildForest(filtered);

    const byProject = new Map<string, typeof summaries>();
    for (const s of filtered) {
      const key = s.cwd ?? "(unknown)";
      const list = byProject.get(key) ?? [];
      list.push(s);
      byProject.set(key, list);
    }
    const groups = [...byProject.entries()]
      .map(([project, sessions]) => ({ project, sessions }))
      .sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0));

    const allTools = new Set<string>();
    for (const s of summaries) for (const t of s.toolNames) allTools.add(t);

    const view = c.req.query("view") === "flat" ? "flat" : "forest";

    const html = (
      <Layout title="pi sessions">
        <SessionList
          groups={groups}
          forest={forest}
          view={view}
          totalCount={filtered.length}
          totalAll={summaries.length}
          filterQuery={filter.q}
          availableTools={[...allTools].sort()}
        />
      </Layout>
    );
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body("<!doctype html>" + html.toString());
  });

  app.get("/s/:id", async (c) => {
    const id = c.req.param("id");
    const view = c.req.query("view") === "flat" ? "flat" : "turns";
    const path = await store.pathFor(id);
    if (!path) return c.text(`session not found: ${id}`, 404);

    const { summary, parsed } = await store.load(path);
    const visibleEntries = tombstones.filter(parsed.entries, id);
    const grouped = view === "turns" ? groupIntoTurns(visibleEntries) : undefined;
    const branches = detectBranches(visibleEntries);
    const tombstoneCount = parsed.entries.length - visibleEntries.length;

    const html = (
      <Layout title={`session ${summary.id}`}>
        <SessionDetail
          summary={summary}
          flatEntries={visibleEntries}
          partial={parsed.partial}
          errors={parsed.errors}
          view={view}
          grouped={grouped}
          branches={branches}
          tombstoneCount={tombstoneCount}
        />
      </Layout>
    );
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body("<!doctype html>" + html.toString());
  });

  app.get("/s/:id/prune", async (c) => {
    const id = c.req.param("id");
    const path = await store.pathFor(id);
    if (!path) return c.text(`session not found: ${id}`, 404);

    const { summary, parsed } = await store.load(path);
    const visibleEntries = tombstones.filter(parsed.entries, id);
    const grouped = groupIntoTurns(visibleEntries);
    const inventory = inventoryPruneCandidates(visibleEntries, grouped);

    const html = (
      <Layout title={`prune · ${summary.id}`}>
        <PrunePage summary={summary} inventory={inventory} />
      </Layout>
    );
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body("<!doctype html>" + html.toString());
  });

  // ---- whole-session purge ----

  app.delete("/api/session/:id", async (c) => {
    const id = c.req.param("id");
    const path = await store.pathFor(id);
    if (!path) return c.json({ ok: false, error: `session not found: ${id}` }, 404);
    const hard = c.req.query("hard") === "1";

    const stat = (() => { try { return statSync(path); } catch { return null; } })();
    const cached = stat ? { sizeBytes: stat.size, mtime: stat.mtimeMs } : null;
    const result = purgeSession(path, { hard });

    const auditPath = writeAuditLog({
      timestamp: new Date().toISOString(),
      op: "purge-session",
      sessionId: id,
      path,
      ...cached,
      ...result,
    });

    if (!result.ok) return c.json({ ok: false, error: result.error, auditPath }, result.status);
    store.evict(path, id);
    return c.json({ ok: true, method: result.method, sessionId: id, sizeBytes: result.sizeBytes, auditPath });
  });

  // ---- per-entry tombstone (viewer-only) ----

  app.post("/api/session/:id/entry/:entryId/tombstone", async (c) => {
    const id = c.req.param("id");
    const entryId = c.req.param("entryId");
    const path = await store.pathFor(id);
    if (!path) return c.json({ ok: false, error: `session not found: ${id}` }, 404);
    const { parsed } = await store.load(path);
    if (!parsed.entries.some((e) => e.id === entryId)) {
      return c.json({ ok: false, error: `entry not found: ${entryId}` }, 404);
    }
    let body: any = {};
    try { body = await c.req.json(); } catch { /* allow empty body */ }
    const reason = typeof body?.reason === "string" ? body.reason : undefined;
    const totalForSession = tombstones.add(id, entryId, reason);
    return c.json({ ok: true, sessionId: id, entryId, totalForSession });
  });

  app.delete("/api/session/:id/entry/:entryId/tombstone", async (c) => {
    const id = c.req.param("id");
    const entryId = c.req.param("entryId");
    const restored = tombstones.remove(id, entryId);
    return c.json({ ok: true, sessionId: id, entryId, restored, alreadyAbsent: !restored });
  });

  // ---- prune snapshot ----

  app.post("/api/session/:id/prune", async (c) => {
    const id = c.req.param("id");
    const path = await store.pathFor(id);
    if (!path) return c.json({ ok: false, error: `session not found: ${id}` }, 404);

    let stat;
    try {
      stat = statSync(path);
    } catch (err) {
      return c.json({ ok: false, error: `stat failed: ${(err as Error).message}` }, 500);
    }
    const sourceAgeSec = Math.round((Date.now() - stat.mtimeMs) / 1000);
    const sourceLikelyActive = sourceAgeSec < Math.round(ACTIVE_WINDOW_MS / 1000);

    let body: any = {};
    try { body = await c.req.json(); } catch { /* allow empty body */ }
    const ids = Array.isArray(body?.selectedIds)
      ? body.selectedIds.filter((x: any) => typeof x === "string")
      : [];
    if (!ids.length) return c.json({ ok: false, error: "no items selected" }, 400);

    const { parsed } = await store.load(path);
    const visibleEntries = tombstones.filter(parsed.entries, id);
    const grouped = groupIntoTurns(visibleEntries);
    const inventory = inventoryPruneCandidates(visibleEntries, grouped);

    const validIds = new Set(inventory.candidates.map((c) => c.id));
    const selected = new Set(ids.filter((x: string) => validIds.has(x)));
    if (!selected.size) {
      return c.json({ ok: false, error: "selected ids didn't match any current candidates" }, 400);
    }

    const { newEntries, report, droppedToolCalls } = applyPrune(visibleEntries, inventory, selected);
    const outPath = writeSnapshot(path, parsed.header, newEntries);

    const auditPath = writeAuditLog({
      timestamp: new Date().toISOString(),
      op: "prune-snapshot",
      sourcePath: path,
      targetPath: outPath,
      selectedCount: selected.size,
      sourceLikelyActive,
      sourceAgeSec,
      report,
      droppedToolCalls,
    });

    void store.refresh(); // surface the new file in the list

    return c.json({
      ok: true,
      sourcePath: path,
      targetPath: outPath,
      report,
      auditPath,
      resumeCommand: `pi --session ${outPath}`,
      sourceLikelyActive,
      sourceAgeSec,
    });
  });

  // ---- 500 handler ----
  app.onError((err, c) => {
    console.error(`[error] ${c.req.path}`, err);
    return c.text(`Internal error on ${c.req.path}\n${err.message}`, 500);
  });

  return app;
}

export type App = ReturnType<typeof buildApp>;

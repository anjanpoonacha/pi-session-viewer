// src/parser/index.ts — JSONL → SessionHeader / Entry[] / Summary.

import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import type { Entry, ParseResult, SessionHeader, Summary } from "../types.ts";

/** Read just the first line for a cheap header-only fetch. */
export async function readHeader(path: string): Promise<SessionHeader | null> {
  return new Promise((resolve) => {
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let resolved = false;
    const finish = (v: SessionHeader | null) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      stream.destroy();
      resolve(v);
    };
    rl.on("line", (line) => {
      try {
        const obj = JSON.parse(line);
        finish(obj?.type === "session" ? (obj as SessionHeader) : null);
      } catch {
        finish(null);
      }
    });
    rl.on("close", () => finish(null));
    rl.on("error", () => finish(null));
  });
}

/** Stream-tolerant full parse: skips malformed lines, marks the session partial. */
export async function readEntries(path: string): Promise<ParseResult> {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  let header: SessionHeader | null = null;
  const entries: Entry[] = [];
  const errors: string[] = [];
  let partial = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      partial = true;
      errors.push(`line ${i + 1}: ${(err as Error).message}`);
      continue;
    }
    if (obj?.type === "session" && header === null) {
      header = obj as SessionHeader;
      continue;
    }
    if (obj && typeof obj === "object" && typeof obj.type === "string") {
      entries.push(obj as Entry);
    } else {
      partial = true;
      errors.push(`line ${i + 1}: not a recognized entry`);
    }
  }

  return { header, entries, partial, errors };
}

/**
 * Build a Summary from a parsed session — used by the list view.
 * Surfaces facets (tools, images, errors, diffs, intercom peers, subagent flag)
 * so the filter bar can match them without re-parsing the file.
 */
export function summarize(path: string, parsed: ParseResult): Summary {
  const stat = statSync(path);
  const header = parsed.header;
  const entries = parsed.entries;

  let messageCount = 0;
  let lastModel: string | undefined;
  let totalCostUsd = 0;
  let totalTokens = 0;
  let name: string | undefined;
  const toolNames = new Set<string>();
  const intercomPeers = new Set<string>();
  let hasImages = false;
  let hasErrors = false;
  let hasDiffs = false;
  let hasIntercom = false;
  let isPoisoned = false;

  for (const e of entries) {
    if (e.type === "message") {
      messageCount++;
      const msg = e.message;
      if (!msg) continue;
      if (Array.isArray(msg.content)) {
        for (const c of msg.content) {
          if (c?.type === "image") hasImages = true;
          if (c?.type === "toolCall" && typeof c.name === "string") toolNames.add(c.name);
          // Poisoned-snapshot detection: a toolCall whose arg string contains
          // "[elided " or "[elided:" was produced by the pre-fix pruner. The
          // shape causes contamination on resume — warn the user not to use it.
          if (c?.type === "toolCall" && c.arguments && typeof c.arguments === "object") {
            for (const v of Object.values(c.arguments)) {
              if (typeof v === "string" && /\[elided[ :]/.test(v)) {
                isPoisoned = true;
              }
            }
          }
        }
      }
      if (msg.role === "assistant") {
        if (msg.model) lastModel = msg.model;
        if (msg.usage) {
          if (typeof msg.usage.totalTokens === "number") totalTokens += msg.usage.totalTokens;
          if (typeof msg.usage.cost?.total === "number") totalCostUsd += msg.usage.cost.total;
        }
        if (msg.stopReason === "error" || msg.stopReason === "aborted") hasErrors = true;
      } else if (msg.role === "toolResult") {
        if (msg.isError) hasErrors = true;
        const det = msg.details;
        if (det && typeof det === "object") {
          if (typeof det.diff === "string" || typeof det.patch === "string" || Array.isArray(det.diffs)) {
            hasDiffs = true;
          }
        }
      }
    } else if (e.type === "session_info" && typeof e.name === "string") {
      name = e.name;
    } else if (e.type === "model_change" && typeof e.modelId === "string") {
      if (!lastModel) lastModel = e.modelId;
    } else if (e.type === "custom" || e.type === "custom_message") {
      const ct = e.customType;
      if (typeof ct === "string" && ct.startsWith("intercom")) {
        hasIntercom = true;
        if (ct === "intercom_sent" && e.data?.to) intercomPeers.add(String(e.data.to));
      }
    }
  }

  return {
    id: header?.id ?? basename(path).replace(/\.jsonl$/, ""),
    path,
    name,
    project: header?.cwd ?? "(unknown cwd)",
    cwd: header?.cwd,
    timestamp: header?.timestamp ?? new Date(stat.mtimeMs).toISOString(),
    mtime: stat.mtimeMs,
    messageCount,
    lastModel,
    totalCostUsd,
    totalTokens,
    sizeBytes: stat.size,
    partial: parsed.partial,
    parentSession: header?.parentSession,
    prunedFromSession: (header as any)?.prunedFromSession,
    prunedFromId: (header as any)?.prunedFromId,
    isPrunedSnapshot: /\.pruned-[^.]+\.jsonl$/.test(path) || !!(header as any)?.prunedFromSession,
    isPoisonedSnapshot: isPoisoned,
    toolNames: [...toolNames].sort(),
    hasImages,
    hasErrors,
    hasDiffs,
    intercomPeers: [...intercomPeers].sort(),
    isSubagent: !!header?.parentSession,
    hasIntercom,
  };
}

/** Convenience: header + entries + summary in one call. */
export async function parseSession(path: string): Promise<{ summary: Summary; parsed: ParseResult }> {
  const parsed = await readEntries(path);
  const summary = summarize(path, parsed);
  return { summary, parsed };
}

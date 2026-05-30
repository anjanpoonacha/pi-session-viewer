// src/engine/forest.ts — build the parent→children forest from parentSession edges.

import type { ForestNode, Summary } from "../types.ts";

export function buildForest(summaries: Summary[]): ForestNode[] {
  const nodeById = new Map<string, ForestNode>();
  for (const s of summaries) nodeById.set(s.id, { summary: s, children: [] });

  const idByPath = new Map<string, string>();
  for (const s of summaries) idByPath.set(s.path, s.id);

  const roots: ForestNode[] = [];
  for (const s of summaries) {
    const node = nodeById.get(s.id)!;
    // Nest pruned snapshots under their source session.
    if (s.prunedFromId) {
      const parent = nodeById.get(s.prunedFromId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    if (s.parentSession) {
      const parentId = idByPath.get(s.parentSession);
      const parent = parentId ? nodeById.get(parentId) : undefined;
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  const sortRec = (node: ForestNode) => {
    node.children.sort((a, b) => b.summary.mtime - a.summary.mtime);
    node.children.forEach(sortRec);
  };
  roots.sort((a, b) => b.summary.mtime - a.summary.mtime);
  roots.forEach(sortRec);
  return roots;
}

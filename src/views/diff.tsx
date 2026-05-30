/** @jsxImportSource hono/jsx */
// src/views/diff.tsx — GitHub-style unified-diff renderer.

type ParsedDiffLine = {
  kind: "add" | "del" | "context" | "nonewline";
  text: string;
  oldLine?: number;
  newLine?: number;
};

type ParsedDiffHunk = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
};

type ParsedDiffFile = {
  fromPath?: string;
  toPath?: string;
  hunks: ParsedDiffHunk[];
  adds: number;
  dels: number;
};

type ParsedDiff = { files: ParsedDiffFile[]; preamble: string | null };

const MAX_DIFF_BYTES = 256 * 1024;

export const DiffBlock = ({ diff }: { diff: string }) => {
  const truncated = diff.length > MAX_DIFF_BYTES;
  const shown = truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff;
  const parsed = parseUnifiedDiff(shown);

  let totalAdds = 0;
  let totalDels = 0;
  for (const f of parsed.files) {
    totalAdds += f.adds;
    totalDels += f.dels;
  }

  return (
    <details class="diff" open>
      <summary class="diff-summary">
        <span class="caret">▸</span>
        <span class="diff-label">diff</span>
        <span class="diff-stats">
          <span class="diff-adds">+{totalAdds}</span>
          <span class="diff-dels">−{totalDels}</span>
          <span class="diff-files dim">
            {parsed.files.length} file{parsed.files.length === 1 ? "" : "s"}
          </span>
        </span>
      </summary>
      <div class="diff-files-list">
        {parsed.files.map((file) => (
          <DiffFile file={file} />
        ))}
        {parsed.preamble && parsed.files.length === 0 ? (
          <pre class="diff-fallback">{shown}</pre>
        ) : null}
      </div>
      {truncated ? <div class="trunc">… diff truncated to {Math.round(MAX_DIFF_BYTES / 1024)} KB</div> : null}
    </details>
  );
};

const DiffFile = ({ file }: { file: ParsedDiffFile }) => (
  <div class="diff-file">
    <div class="diff-file-header">
      <span class="diff-file-icon">📄</span>
      <span class="diff-file-path">{file.toPath || file.fromPath || "(unknown)"}</span>
      <span class="diff-file-stats">
        <span class="diff-adds">+{file.adds}</span>
        <span class="diff-dels">−{file.dels}</span>
      </span>
    </div>
    <div class="diff-table-wrap">
      <table class="diff-table">
        {file.hunks.map((hunk) => (
          <DiffHunk hunk={hunk} />
        ))}
      </table>
    </div>
  </div>
);

const DiffHunk = ({ hunk }: { hunk: ParsedDiffHunk }) => (
  <>
    <tr class="diff-row diff-hunk-row">
      <td class="diff-num diff-num-old"></td>
      <td class="diff-num diff-num-new"></td>
      <td class="diff-marker"></td>
      <td class="diff-content diff-hunk-content">{hunk.header}</td>
    </tr>
    {hunk.lines.map((line) => (
      <tr class={`diff-row diff-row-${line.kind}`}>
        <td class="diff-num diff-num-old">{line.kind === "add" ? "" : line.oldLine ?? ""}</td>
        <td class="diff-num diff-num-new">{line.kind === "del" ? "" : line.newLine ?? ""}</td>
        <td class="diff-marker">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</td>
        <td class="diff-content">
          <span class="diff-line-text">{line.text || "\u00a0"}</span>
        </td>
      </tr>
    ))}
  </>
);

// ---- parser ----

export function parseUnifiedDiff(input: string): ParsedDiff {
  const lines = input.split("\n");
  const files: ParsedDiffFile[] = [];
  const preambleLines: string[] = [];
  let curFile: ParsedDiffFile | null = null;
  let curHunk: ParsedDiffHunk | null = null;
  let oldLineNo = 0;
  let newLineNo = 0;
  let i = 0;

  const flushFile = () => {
    if (curFile) files.push(curFile);
    curFile = null;
    curHunk = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("--- ")) {
      flushFile();
      const fromPath = stripDiffPathPrefix(line.slice(4));
      let toPath: string | undefined;
      if (i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
        toPath = stripDiffPathPrefix(lines[i + 1].slice(4));
        i += 2;
      } else {
        i += 1;
      }
      curFile = { fromPath, toPath, hunks: [], adds: 0, dels: 0 };
      curHunk = null;
      continue;
    }

    const hunkMatch = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/.exec(line);
    if (hunkMatch) {
      if (!curFile) curFile = { hunks: [], adds: 0, dels: 0 };
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1;
      curHunk = { header: line, oldStart, oldCount, newStart, newCount, lines: [] };
      curFile.hunks.push(curHunk);
      oldLineNo = oldStart;
      newLineNo = newStart;
      i += 1;
      continue;
    }

    if (line.startsWith("\\ ")) {
      curHunk?.lines.push({ kind: "nonewline", text: line.slice(2) });
      i += 1;
      continue;
    }

    if (curHunk) {
      if (line.startsWith("+")) {
        curHunk.lines.push({ kind: "add", text: line.slice(1), newLine: newLineNo });
        newLineNo++;
        if (curFile) curFile.adds++;
        i += 1;
        continue;
      }
      if (line.startsWith("-")) {
        curHunk.lines.push({ kind: "del", text: line.slice(1), oldLine: oldLineNo });
        oldLineNo++;
        if (curFile) curFile.dels++;
        i += 1;
        continue;
      }
      if (line.startsWith(" ") || line === "") {
        const text = line.startsWith(" ") ? line.slice(1) : line;
        curHunk.lines.push({ kind: "context", text, oldLine: oldLineNo, newLine: newLineNo });
        oldLineNo++;
        newLineNo++;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (!curFile) preambleLines.push(line);
    i += 1;
  }

  flushFile();
  return { files, preamble: preambleLines.length ? preambleLines.join("\n") : null };
}

function stripDiffPathPrefix(p: string): string {
  let s = p.split("\t")[0].trim();
  if (s === "/dev/null") return s;
  if (s.startsWith("a/") || s.startsWith("b/")) return s.slice(2);
  return s;
}

/** Look up a unified diff in `details`. Prefers `patch` (real GitHub-style). */
export function extractDiff(details: any): string | null {
  if (!details || typeof details !== "object") return null;
  if (typeof details.patch === "string" && looksLikeDiff(details.patch)) return details.patch;
  if (typeof details.diff === "string" && looksLikeDiff(details.diff)) return details.diff;
  if (Array.isArray(details.diffs)) {
    const joined = details.diffs.filter((d: any) => typeof d === "string").join("\n");
    if (looksLikeDiff(joined)) return joined;
  }
  return null;
}

function looksLikeDiff(s: string): boolean {
  if (!s || s.length < 4) return false;
  return /^(?:---|\+\+\+|@@|diff )/m.test(s) || /^\s*[+-]\s/m.test(s);
}

// Semantic Block AST — the intermediate representation between the ANSI parse and the React
// renderer. Today there is exactly one block kind (`raw`), which mirrors terminal output verbatim;
// the discriminated union is shaped so future grammars (prompt selects, tool calls, …) are added as
// new `kind`s without disturbing this one.
//
// The pipeline is: parseAnsi(text) → AnsiSegment[] → splitLines(segments) → StyledLine[] →
// buildBlocks(lines) → Block[]. These functions are PURE (no React) and, together with the parser,
// run once per unique text (memoised by the renderer), so they're off the hot polling path.
//
// Invariant (relied on by find-in-output): joining every line's text with "\n" reproduces the
// original visible text character-for-character. Find operates on global character offsets over that
// same string, so line-splitting must not add or drop a single byte.

import type { AnsiSegment } from "./ansi";

/** One visual line: the styled segments that make it up, with the line-terminating "\n" removed. */
export interface StyledLine {
  segments: AnsiSegment[];
}

/** A run of raw terminal output — the only block kind today. Renders as verbatim styled text. */
export interface RawBlock {
  kind: "raw";
  lines: StyledLine[];
}

/**
 * A semantic block. A discriminated union on `kind`; `raw` is the sole member for now. Later stages
 * add members (e.g. `prompt-select`, `tool-call`) — purely additively, so a `switch (block.kind)`
 * in the renderer stays exhaustive.
 */
export type Block = RawBlock;

/**
 * Split parsed segments into visual lines at "\n" boundaries. The newline characters become the
 * separators *between* lines and are dropped from segment text, so `lines.map(text).join("\n")`
 * reconstructs the original visible string exactly.
 *
 * A segment whose text has no newline is reused as-is (no allocation). A segment carrying newline(s)
 * is sliced into per-line pieces that each keep the original segment's style/flags — so a styled run
 * straddling a line break stays styled on both sides. Empty pieces (adjacent newlines, or a leading/
 * trailing newline) contribute no segment but still open/close a line, preserving blank lines.
 */
export function splitLines(segments: AnsiSegment[]): StyledLine[] {
  const lines: StyledLine[] = [];
  let current: AnsiSegment[] = [];

  for (const seg of segments) {
    const t = seg.text;
    if (t.indexOf("\n") === -1) {
      // Common case (parser flushes at every "\n", so most segments have none): reuse verbatim.
      current.push(seg);
      continue;
    }
    // Segment contains one or more newlines: distribute its text across the lines it spans, cloning
    // the style onto each non-empty piece.
    let start = 0;
    for (;;) {
      const idx = t.indexOf("\n", start);
      const end = idx === -1 ? t.length : idx;
      if (end > start) current.push({ ...seg, text: t.slice(start, end) });
      if (idx === -1) break;
      lines.push({ segments: current });
      current = [];
      start = idx + 1;
    }
  }

  // The trailing run (after the last "\n", or the whole input if it had none) is the final line —
  // pushed even when empty so a trailing newline yields a terminating blank line.
  lines.push({ segments: current });
  return lines;
}

/**
 * Group lines into semantic blocks. For now this is trivial — a single `raw` block spanning every
 * line — but it's the seam where later stages detect prompts/tool-calls and emit typed blocks.
 */
export function buildBlocks(lines: StyledLine[]): Block[] {
  return [{ kind: "raw", lines }];
}

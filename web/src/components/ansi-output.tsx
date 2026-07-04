import { Fragment, memo, useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { parseAnsi, type AnsiSegment } from "@/lib/ansi";
import { buildBlocks, splitLines, type Block } from "@/lib/blocks";
import { findMatches, splitSegment, type FindMatch } from "@/lib/find";

export interface AnsiOutputProps {
  text: string;
  className?: string;
  /** false = no wrap; the block scrolls horizontally, preserving column alignment. Default true. */
  wrap?: boolean;
  /** Monospace font size in px. Default 11. */
  fontSize?: number;
  /** Active find query. Empty (the default) = not searching: the fast, allocation-free render path. */
  query?: string;
  /** Index of the focused match — highlighted stronger and scrolled into view. -1 = none. */
  currentMatch?: number;
  /** Reports the current match count back to the parent (drives the find bar's "3/17"). */
  onMatchCount?: (count: number) => void;
}

// Stable empty result so the "not searching" path keeps the same `matches` reference across polls
// (no needless effect re-runs / parent count updates while find is closed).
const NO_MATCHES: FindMatch[] = [];

function preClass(wrap: boolean, className?: string): string {
  return cn(
    "m-0 font-mono leading-[1.35] text-foreground/90",
    wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre overflow-x-auto",
    className,
  );
}

// Faithful, colored mirror of a pane's recent terminal output. Rendering flows through the Block AST
// (blocks.ts): parseAnsi → styled lines → typed blocks → React. Text is always rendered as React
// text nodes (escaped); only color/weight come from the ANSI parse — no XSS surface.
//
// The one block kind today is `raw`, which reproduces exactly what the flat renderer produced: one
// <span> per segment, with the line-splitting newlines re-emitted as bare "\n" text nodes between
// lines (still React text nodes). Under the <pre>'s whitespace-pre[-wrap] this is byte-for-byte the
// same text the old renderer emitted, so it wraps and breaks identically.
//
// Find-in-output highlights matches by splitting each segment's *text* around the match ranges and
// wrapping the matched slices in styled <span>s. Match offsets are GLOBAL over the whole buffer: the
// haystack is the concatenation of every segment's text (identical to the pre-blocks string, incl.
// the newlines), and the renderer threads a running offset through blocks → lines → segments so each
// segment maps back to that same coordinate space. The current match gets a stronger intensity and
// is scrolled into view. (A find query can't contain a newline, so no match ever straddles the
// inter-line separators — the coordinate space matches the old one exactly.)
//
// Performance: parseAnsi + block-building run once per unique `text` value (useMemo), and React.memo
// prevents re-renders when props are unchanged — critical for the polling cadence on mobile. When
// not searching (`query` empty) the render skips splitSegment entirely (one plain span per segment).
export const AnsiOutput = memo(function AnsiOutput({
  text,
  className,
  wrap = true,
  fontSize = 11,
  query = "",
  currentMatch = -1,
  onMatchCount,
}: AnsiOutputProps) {
  const segments = useMemo(() => parseAnsi(text), [text]);
  const blocks = useMemo(() => buildBlocks(splitLines(segments)), [segments]);

  // Matches live in offsets over the *visible* text (concatenated segment text, newlines included).
  // The join only runs while actually searching, so the idle polling path pays nothing.
  const matches = useMemo(() => {
    if (!query) return NO_MATCHES;
    return findMatches(segments.map((s) => s.text).join(""), query);
  }, [segments, query]);

  useEffect(() => {
    onMatchCount?.(matches.length);
  }, [matches, onMatchCount]);

  const currentRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (currentMatch < 0) return;
    currentRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [currentMatch, matches]);

  const styleFor = (s: AnsiSegment): CSSProperties =>
    s.muted ? { ...s.style, color: "var(--border)", fontWeight: 400 } : s.style;

  // Fast path — not searching. No global offsets, no splitSegment: one plain span per segment, with
  // "\n" text nodes between lines (and between blocks). Identical DOM text to the pre-blocks render.
  if (matches.length === 0) {
    return (
      <pre className={preClass(wrap, className)} style={{ fontSize: `${fontSize}px` }}>
        {blocks.map((block, bi) => (
          <Fragment key={bi}>
            {bi > 0 ? "\n" : null}
            {block.lines.map((line, li) => (
              <Fragment key={li}>
                {li > 0 ? "\n" : null}
                {line.segments.map((s, si) => (
                  <span key={si} style={styleFor(s)}>
                    {s.text}
                  </span>
                ))}
              </Fragment>
            ))}
          </Fragment>
        ))}
      </pre>
    );
  }

  // Highlight path. Thread a running global offset through blocks → lines → segments (advancing by 1
  // for each inter-line/inter-block "\n" separator) so splitSegment can tag each segment's slices
  // with the global match index. `currentAssigned` refs only the first slice of the focused match (a
  // match can span segments on a colour change) so scrollIntoView targets one stable node.
  let offset = 0;
  let currentAssigned = false;
  const renderBlock = (block: Block, bi: number) => {
    if (bi > 0) offset += 1; // the "\n" separating this block from the previous
    return (
      <Fragment key={bi}>
        {bi > 0 ? "\n" : null}
        {block.lines.map((line, li) => {
          if (li > 0) offset += 1; // the "\n" separating this line from the previous
          const segNodes = line.segments.map((s, si) => {
            const segStart = offset;
            offset += s.text.length;
            const pieces = splitSegment(s.text, segStart, matches);
            return (
              <span key={si} style={styleFor(s)}>
                {pieces.map((p, j) => {
                  if (p.matchIndex === null) return p.text;
                  const isCurrent = p.matchIndex === currentMatch;
                  const attach = isCurrent && !currentAssigned;
                  if (attach) currentAssigned = true;
                  return (
                    <span
                      key={j}
                      ref={attach ? currentRef : undefined}
                      data-find-match={isCurrent ? "current" : "other"}
                      className={cn(
                        "rounded-[2px]",
                        isCurrent ? "bg-yellow-400 text-black" : "bg-yellow-400/30",
                      )}
                    >
                      {p.text}
                    </span>
                  );
                })}
              </span>
            );
          });
          return (
            <Fragment key={li}>
              {li > 0 ? "\n" : null}
              {segNodes}
            </Fragment>
          );
        })}
      </Fragment>
    );
  };

  return (
    <pre className={preClass(wrap, className)} style={{ fontSize: `${fontSize}px` }}>
      {blocks.map(renderBlock)}
    </pre>
  );
});

// The prompt-select race guard, factored out of AgentChat so it's directly testable (and reused by
// the component's integration test). Tapping a menu button can type into a REAL terminal, and the
// pane may have moved on between render and tap — so before sending we re-fetch the pane and confirm
// nothing changed underfoot:
//
//   1. A FRESH pane read for the same window.
//   2. The fresh read's `revision` must equal the one the menu was detected against — checked
//      UNCONDITIONALLY. A 304 Not Modified only proves the buffer is unchanged since the ETag
//      cache's LAST background poll, NOT since the (possibly frozen) snapshot the user tapped on —
//      the cache advances with every poll while a frozen mirror stands still. The cached 304 body
//      carries its own `revision`, so the comparison works on both paths.
//   3. The fresh buffer must additionally still re-derive to the same {question, options}
//      (family + labels) — on EVERY path, 304 included, because Herdr 0.7.x's revision field is
//      empirically a stub (always 0) and the re-derivation is the only load-bearing check today.
//
// Only then do we send the option's keys through the existing sendKeys write path. A failed guard
// discards the tap and reports "changed" so the caller can surface a "menu changed" notice.

import { fetchPane, sendKeys } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type PromptModel, type PromptOption } from "./blocks";
import { detectPromptSelect } from "./grammar/prompt-select";

/** Whether two detected dialogs resolve to the same choice: family, question, and option labels.
 *  (Descriptions/keys are derived, so they can't differ without a label or family change first.) */
export function promptsEqual(a: PromptModel, b: PromptModel): boolean {
  return (
    a.family === b.family &&
    a.question === b.question &&
    a.options.length === b.options.length &&
    a.options.every((o, i) => o.label === b.options[i]!.label)
  );
}

export type PromptActionResult =
  | { status: "sent" }
  | { status: "changed" }
  | { status: "error"; error: string };

/**
 * Run the race guard and, if it passes, send `option.keys`. Pure of any UI — the caller maps the
 * result to a status message and a revalidation.
 */
export async function submitPromptOption(args: {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered menu was detected against. */
  detectedRevision: number;
  prompt: PromptModel;
  option: PromptOption;
}): Promise<PromptActionResult> {
  const { paneId, requestedLines, detectedRevision, prompt, option } = args;

  let fresh;
  try {
    fresh = await fetchPane(paneId, requestedLines);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  // Revision check is UNCONDITIONAL: a 304 only means "unchanged since the last poll", and polls
  // keep advancing the ETag cache under a frozen mirror — it does NOT vouch for the snapshot the
  // user actually tapped on. The cached 304 body carries its revision, so this covers both paths.
  if (fresh.revision !== detectedRevision) return { status: "changed" };
  // EMPIRICAL (Herdr 0.7.x, live-verified 2026-07-05): pane.read's `revision` is a stub upstream —
  // it is always 0, even for actively-changing panes. The gate above is therefore defense-in-depth
  // for future Herdr versions, NOT load-bearing. So the menu re-derivation below runs on EVERY
  // path, including 304: the fresh (= latest cached) text is exactly what a tap on a possibly
  // frozen mirror must be compared against. One parse per tap — taps are rare, correctness isn't.
  const freshModel = detectPromptSelect(splitLines(parseAnsi(fresh.text)));
  if (!freshModel || !promptsEqual(freshModel, prompt)) return { status: "changed" };

  try {
    const res = await sendKeys(paneId, option.keys);
    if (!res.ok) return { status: "error", error: res.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

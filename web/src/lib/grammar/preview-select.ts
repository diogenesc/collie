// Preview-variant AskUserQuestion detection — the grammar that recognises Claude Code's PREVIEW
// dialog (options in a fixed left column, the pointed option's preview pane on the right, and the
// per-question "Notes:" affordance) at the TAIL of a pane buffer, and lifts it into a
// `PreviewSelectModel` the UI renders natively — including the note add/edit flow.
//
// This variant renders for a question that is !multiSelect AND has ≥1 option with a `preview`
// field, both as a single-question dialog and as a step inside the multi-question wizard. Its
// choreography differs sharply from the standard select/wizard (digits only MOVE the pointer, the
// `n` key opens a note input, Enter inside that input submits/advances) — the verified ground
// truth lives in NOTES_NOTES.md. The T2/T7 grammars never match this layout (the footer sits far
// below the option rows, outside their MAX_FOOTER_GAP), so this detector adds a new surface rather
// than re-arbitrating an existing one.
//
// Everything here is PURE over `StyledLine[]`, fixture-driven (web/src/fixtures/panes/
// claude--*preview*.txt), and never touches a pane or the network.

import type { StyledLine } from "../blocks";
import { classifyFooter, isBlank, isHorizontalRule, lineText } from "./markers";
import { parseOptionRow } from "./prompt-select";
import { parseStepperLine, type WizardStepChip } from "./wizard";

/** The per-question note, parsed off the `Notes:` line + the footer's focus marker. */
export interface PreviewNote {
  /**
   * `none`: the dim "press n to add notes" hint — no note attached.
   * `editing`: the TUI's note input is FOCUSED (footer shows "ctrl+g to edit …") — keystrokes go
   * into the input, so Collie must not drive the dialog until it blurs.
   * `attached`: a committed note is on the question (input blurred).
   */
  state: "none" | "editing" | "attached";
  /** The visible note text ("" for none / the empty placeholder). The TUI windows the display at
   *  ~60 columns, so a long note may be a truncated readback. */
  text: string;
}

/** One selectable option of the preview dialog. */
export interface PreviewOption {
  /** The visible label (a React text node downstream — the XSS boundary is unchanged). */
  label: string;
  /** The option's digit. In this variant the digit only MOVES the pointer; selection is a separate
   *  Enter once the pointer is verified (see preview-action.ts — never send both in one call). */
  n: number;
  /** This row carries the `❯` pointer — the row Enter would select, and the preview pane's owner. */
  pointed: boolean;
  /** Trailing ` ✔` on a revisited, already-answered wizard question's chosen row. */
  chosen: boolean;
}

/** A detected preview-variant AskUserQuestion (single-question or one wizard step). */
export interface PreviewSelectModel {
  question: string;
  options: PreviewOption[];
  /** The right-hand preview pane of the POINTED option, as plain text lines (borders included). */
  preview: string[];
  note: PreviewNote;
  /** The wizard stepper chips when this question is a step of a multi-question dialog; null for a
   *  single-question dialog. Navigation uses the same Left/Right keys as the standard wizard. */
  steps: WizardStepChip[] | null;
}

/** Detection result for buildBlocks: the model plus the region's first line — the preview region
 *  is [`startLine` … tail], which the renderer replaces with the native block. */
export interface PreviewSelectRegion {
  model: PreviewSelectModel;
  startLine: number;
}

// The footer discriminator: a select-family footer that also advertises the note key. This is the
// single most specific anchor of the variant (no other Claude dialog mentions it).
const NOTES_FOOTER = /\bn to add notes\b/i;
// While the note input is focused the footer additionally offers the external-editor escape.
const NOTE_EDITING_FOOTER = /ctrl\+g to edit\b/i;

// The two literal Notes-line states Claude Code renders (the placeholder's … is U+2026).
const NOTE_HINT = "press n to add notes";
const NOTE_PLACEHOLDER = "Add notes on this design…";

// The unnumbered escape row below the rule ("Chat about this", possibly carrying the pointer).
// Not reachable via Down (it clamps at the last option), so it is tolerated but never up-levelled.
const ESCAPE_ROW = /^❯?\s*Chat about this$/;

/** The chosen-row marker a revisited answered question shows: "1. Grid ✔". */
const CHOSEN_SUFFIX = /\s*✔\s*$/;

// Bounded windows, same philosophy as the sibling grammars: the Notes line sits within a few lines
// of the footer (rule + escape row between); options+preview sit within a screenful above it.
const NOTES_SCAN_LIMIT = 8;
const OPTION_SCAN_WINDOW = 28;
const QUESTION_SCAN_LIMIT = 12;
const STEPPER_SCAN_LIMIT = 6;

/**
 * Detect a preview-variant dialog at the tail of `lines`. Returns the model + its start line, or
 * null when the tail isn't one. Pure; the caller owns pane access.
 */
export function detectPreviewSelectRegion(lines: StyledLine[]): PreviewSelectRegion | null {
  const texts = lines.map(lineText);

  // 1. Tail anchor: the last non-blank line is a select-family footer that offers `n to add notes`.
  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;
  const footer = texts[fi]!;
  if (classifyFooter(footer) !== "select" || !NOTES_FOOTER.test(footer)) return null;
  const editing = NOTE_EDITING_FOOTER.test(footer);

  // 2. The `Notes:` line, a few lines above the footer. Between them only the escape row, the
  //    rule, and blanks may appear — anything else means an unknown layout, so bail to raw.
  let notesIdx = -1;
  for (let i = fi - 1, seen = 0; i >= 0 && seen < NOTES_SCAN_LIMIT; i--, seen++) {
    const t = texts[i]!;
    const trimmed = t.trim();
    if (trimmed.startsWith("Notes:")) {
      notesIdx = i;
      break;
    }
    if (isBlank(t) || isHorizontalRule(t) || ESCAPE_ROW.test(trimmed)) continue;
    return null;
  }
  if (notesIdx < 0) return null;

  // The Notes label's column anchors the preview pane: everything left of it on the rows above is
  // option-list territory, everything from it rightward is preview content.
  const noteCol = texts[notesIdx]!.indexOf("Notes:");
  const note = parseNote(texts[notesIdx]!.slice(noteCol + "Notes:".length), editing);

  // 3. Option rows: numbered rows 1..k in CONSECUTIVE lines (the left column never wraps its
  //    30-col labels), matched on the text LEFT of the preview column.
  const from = Math.max(0, notesIdx - OPTION_SCAN_WINDOW);
  const rows: { index: number; n: number; label: string; pointed: boolean }[] = [];
  for (let i = from; i < notesIdx; i++) {
    const left = texts[i]!.slice(0, noteCol);
    const parsed = parseOptionRow(left);
    if (parsed) rows.push({ index: i, pointed: /^\s*❯/.test(left), ...parsed });
  }
  if (rows.length < 2) return null;
  if (rows.some((r, k) => r.n !== k + 1 || r.index !== rows[0]!.index + k)) return null;
  const firstOpt = rows[0]!.index;
  const lastOpt = rows[rows.length - 1]!.index;

  // Below the last row and above the Notes line only preview continuation (blank left column) may
  // appear — a non-blank left cell there is a layout we don't know.
  for (let i = lastOpt + 1; i < notesIdx; i++) {
    if (!isBlank(texts[i]!.slice(0, noteCol))) return null;
  }

  // 4. The preview pane: the right column of the region's lines, verbatim (borders included).
  const preview: string[] = [];
  for (let i = firstOpt; i < notesIdx; i++) preview.push(texts[i]!.slice(noteCol).trimEnd());
  while (preview.length > 0 && preview[0]!.length === 0) preview.shift();
  while (preview.length > 0 && preview[preview.length - 1]!.length === 0) preview.pop();

  // 5. The question above the options (every dialog's prompt carries a "?"), bounded, stopping at
  //    a rule so the search can't cross out of the dialog.
  let questionIdx = -1;
  for (let i = firstOpt - 1, seen = 0; i >= 0 && seen < QUESTION_SCAN_LIMIT; i--, seen++) {
    const t = texts[i]!;
    if (isHorizontalRule(t)) break;
    if (t.includes("?")) {
      questionIdx = i;
      break;
    }
  }
  if (questionIdx < 0) return null;

  // 6. A wizard stepper above the question makes this a wizard step (Left/Right navigation applies
  //    and the question joins the block region, as in the standard wizard grammar). A lone chip
  //    line (" ☐ Design") never parses as a stepper, so single-question dialogs get steps: null.
  let steps: WizardStepChip[] | null = null;
  let startLine = firstOpt;
  let question = texts[questionIdx]!.trim();
  for (let i = questionIdx - 1, seen = 0; i >= 0 && seen < STEPPER_SCAN_LIMIT; i--, seen++) {
    if (isHorizontalRule(texts[i]!)) break;
    const stepper = parseStepperLine(lines[i]!);
    if (stepper) {
      steps = stepper.chips;
      startLine = i;
      // Long questions wrap; in the wizard form every non-blank line between the stepper and the
      // options is the question (mirrors wizard.ts).
      const parts: string[] = [];
      for (let j = i + 1; j < firstOpt; j++) {
        if (!isBlank(texts[j]!)) parts.push(texts[j]!.trim());
      }
      if (parts.length > 0) question = parts.join(" ");
      break;
    }
  }

  const options: PreviewOption[] = rows.map((r) => ({
    label: r.label.replace(CHOSEN_SUFFIX, ""),
    n: r.n,
    pointed: r.pointed,
    chosen: CHOSEN_SUFFIX.test(r.label),
  }));

  return { model: { question, options, preview, note, steps }, startLine };
}

/** Just the model (or null) — the race guard's re-derivation entry point. */
export function detectPreviewSelect(lines: StyledLine[]): PreviewSelectModel | null {
  return detectPreviewSelectRegion(lines)?.model ?? null;
}

/** Parse the text after "Notes:" into the note's state + text (NOTES_NOTES.md table). */
function parseNote(rest: string, editing: boolean): PreviewNote {
  const text = rest.trim();
  if (text === NOTE_HINT && !editing) return { state: "none", text: "" };
  if (text === NOTE_PLACEHOLDER && editing) return { state: "editing", text: "" };
  return { state: editing ? "editing" : "attached", text };
}

import { describe, expect, it, beforeEach, vi } from "vitest";

// The preview-dialog choreography engine: entry guard + the multi-step recipes (digit→verify→Enter
// for options, n→verify→clear→type→Escape for notes; grammar/NOTES_NOTES.md). The api layer is
// mocked so the mid-flight pane states can be sequenced precisely; the detector is the real thing,
// driven by synthetic plain-text buffers (styling only matters for the wizard stepper's current
// chip, which these single-question buffers don't carry).
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  sendReply: vi.fn(),
}));

import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { detectPreviewSelect } from "./grammar/preview-select";
import {
  NOTE_MAX_LENGTH,
  previewsEqual,
  submitPreviewKeys,
  submitPreviewNote,
  submitPreviewOption,
} from "./preview-action";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);
const mockSendReply = vi.mocked(sendReply);

// A synthetic preview dialog in the exact live layout (fixtures claude--select-preview*.txt):
// fixed-width label column, preview pane + Notes line sharing a column, rule, escape row, footer.
function buffer(opts: { pointer?: number; note?: string; editing?: boolean; question?: string }) {
  const pointer = opts.pointer ?? 1;
  const labels = ["Boxy", "Rounded", "Minimal"];
  const pane = ["┌─────────┐", "│ MOCKUP  │", "└─────────┘"];
  const col = 34;
  const rows = labels.map((label, i) => {
    const left = `${pointer === i + 1 ? "❯" : " "} ${i + 1}. ${label}`;
    return left.padEnd(col) + (pane[i] ?? "");
  });
  const noteText = opts.editing
    ? (opts.note ?? "") || "Add notes on this design…"
    : (opts.note ?? "") || "press n to add notes";
  const footer =
    "Enter to select · ↑/↓ to navigate · n to add notes" +
    (opts.editing ? " · ctrl+g to edit in nano" : "") +
    " · Esc to cancel";
  return [
    " ☐ Design",
    "",
    opts.question ?? "Which widget design should we use?",
    "",
    ...rows,
    "",
    " ".repeat(col) + `Notes: ${noteText}`,
    "",
    "─".repeat(60),
    "  Chat about this",
    "",
    footer,
  ].join("\n");
}

function model(opts: Parameters<typeof buffer>[0]) {
  const m = detectPreviewSelect(splitLines(parseAnsi(buffer(opts))));
  if (!m) throw new Error("synthetic buffer did not detect");
  return m;
}

function paneWith(text: string, revision = 5) {
  return { paneId: "w1:p1", text, truncated: false, revision };
}

const noSleep = async () => {};
const base = { paneId: "w1:p1", requestedLines: 600, detectedRevision: 5, sleep: noSleep };

beforeEach(() => {
  mockFetchPane.mockReset();
  mockSendKeys.mockReset();
  mockSendReply.mockReset();
  mockSendKeys.mockResolvedValue({ ok: true });
  mockSendReply.mockResolvedValue({ ok: true });
});

describe("previewsEqual", () => {
  it("equal for the same buffer; unequal across pointer, note, and question changes", () => {
    expect(previewsEqual(model({}), model({}))).toBe(true);
    // A pointer move re-routes what Enter would select — it must invalidate a tap.
    expect(previewsEqual(model({}), model({ pointer: 2 }))).toBe(false);
    // A note appearing/changing is a visible state change.
    expect(previewsEqual(model({}), model({ note: "hi" }))).toBe(false);
    expect(previewsEqual(model({ note: "a" }), model({ note: "b" }))).toBe(false);
    // The TUI input opening flips the note state even with no text yet.
    expect(previewsEqual(model({}), model({ editing: true }))).toBe(false);
    expect(previewsEqual(model({}), model({ question: "Something else?" }))).toBe(false);
  });
});

describe("submitPreviewOption — digit → verify pointer → Enter", () => {
  it("sends the digit, waits for the pointer to land on the row, then confirms with Enter", async () => {
    const m = model({ pointer: 1 });
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer({ pointer: 1 }))) // entry guard
      .mockResolvedValue(paneWith(buffer({ pointer: 2 }))); // verification poll
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[1]! });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["2"]],
      ["w1:p1", ["Enter"]],
    ]);
  });

  it("never sends Enter when the pointer does not converge (digit was the only side effect)", async () => {
    const m = model({ pointer: 1 });
    mockFetchPane.mockResolvedValue(paneWith(buffer({ pointer: 1 }))); // pointer never moves
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[2]! });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["3"]]]);
  });

  it("rejects at the entry guard when the dialog changed underfoot (no keys at all)", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValue(paneWith(buffer({ question: "Different question?" })));
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[0]! });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("rejects when the fresh revision differs (frozen mirror, advanced pane)", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValue(paneWith(buffer({}), 9));
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[0]! });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("aborts the verification poll early when the dialog's identity drifts mid-flight", async () => {
    const m = model({ pointer: 1 });
    mockFetchPane
      .mockResolvedValueOnce(paneWith(buffer({ pointer: 1 })))
      .mockResolvedValue(paneWith(buffer({ question: "Another dialog entirely?" })));
    const res = await submitPreviewOption({ ...base, preview: m, option: m.options[1]! });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["2"]]]); // digit only, no Enter
  });
});

describe("submitPreviewNote — n → verify focus → clear → type → Escape (never Enter)", () => {
  // Every stage of the choreography is verified against a fresh read before the next fires, so the
  // mock serves a SCRIPT of pane states: each fetch consumes one entry, the last repeats.
  function script(...texts: string[]) {
    const queue = [...texts];
    mockFetchPane.mockImplementation(async () =>
      paneWith(queue.length > 1 ? queue.shift()! : queue[0]!),
    );
  }

  it("adds a fresh note: n, focus poll, reply-typed text (verified), Escape (verified) — no clear", async () => {
    const m = model({});
    script(
      buffer({}), // entry guard
      buffer({ editing: true }), // input focused
      buffer({ editing: true, note: "focus on mobile" }), // text rendered
      buffer({ note: "focus on mobile" }), // blurred: note attached
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: "focus on mobile" });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls).toEqual([
      ["w1:p1", ["n"]],
      ["w1:p1", ["Escape"]],
    ]);
    expect(mockSendReply.mock.calls).toEqual([["w1:p1", "focus on mobile", false]]);
  });

  it("replaces an existing note with the deterministic clear (ctrl+k + Backspace sweep)", async () => {
    const m = model({ note: "old note" });
    script(
      buffer({ note: "old note" }), // entry guard
      buffer({ note: "old note", editing: true }), // input focused (old text intact)
      buffer({ editing: true }), // cleared: empty input
      buffer({ editing: true, note: "new note" }), // new text rendered
      buffer({ note: "new note" }), // blurred: replaced
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: "new note" });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys.mock.calls[0]).toEqual(["w1:p1", ["n"]]);
    const clear = mockSendKeys.mock.calls[1]![1];
    expect(clear[0]).toBe("ctrl+k");
    expect(clear.length).toBe(1 + NOTE_MAX_LENGTH + 20);
    expect(clear.slice(1).every((k: string) => k === "Backspace")).toBe(true);
    expect(mockSendKeys.mock.calls[2]).toEqual(["w1:p1", ["Escape"]]);
    expect(mockSendReply).toHaveBeenCalledWith("w1:p1", "new note", false);
  });

  it("removes a note with empty text: clear + Escape, nothing typed", async () => {
    const m = model({ note: "old note" });
    script(
      buffer({ note: "old note" }),
      buffer({ note: "old note", editing: true }),
      buffer({ editing: true }), // cleared
      buffer({}), // blurred: hint line back, note gone
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: "" });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendReply).not.toHaveBeenCalled();
    expect(mockSendKeys.mock.calls.map((c) => c[1][0])).toEqual(["n", "ctrl+k", "Escape"]);
  });

  it("collapses whitespace/newlines and caps the typed text", async () => {
    const raw = "  a\nb\t c  " + "x".repeat(400);
    const expected = raw.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX_LENGTH);
    const m = model({});
    script(
      buffer({}),
      buffer({ editing: true }),
      buffer({ editing: true, note: expected }),
      buffer({ note: expected }),
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: raw });
    expect(res).toEqual({ status: "sent" });
    const typed = mockSendReply.mock.calls[0]![1] as string;
    expect(typed).toBe(expected);
    expect(typed.startsWith("a b c x")).toBe(true);
    expect(typed).not.toMatch(/[\n\t]/);
    expect(typed.length).toBe(NOTE_MAX_LENGTH);
  });

  it("retries a swallowed Escape once (the blur is verified, not assumed)", async () => {
    const m = model({});
    script(
      buffer({}), // entry guard
      buffer({ editing: true }), // focused
      buffer({ editing: true, note: "hi" }), // text rendered — but then the input STAYS focused
      ...Array.from({ length: 8 }, () => buffer({ editing: true, note: "hi" })), // 1st blur poll times out
      buffer({ note: "hi" }), // 2nd Escape lands
    );
    const res = await submitPreviewNote({ ...base, preview: m, text: "hi" });
    expect(res).toEqual({ status: "sent" });
    const escapes = mockSendKeys.mock.calls.filter((c) => c[1][0] === "Escape");
    expect(escapes).toHaveLength(2);
  });

  it("refuses while the TUI's note input is already focused (keys would corrupt it)", async () => {
    const m = model({ editing: true });
    const res = await submitPreviewNote({ ...base, preview: m, text: "hello" });
    expect(res).toEqual({ status: "changed" });
    expect(mockFetchPane).not.toHaveBeenCalled();
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  it("stops dead (no blind Escape) when the input never opens", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValue(paneWith(buffer({}))); // editing state never appears
    const res = await submitPreviewNote({ ...base, preview: m, text: "hello" });
    expect(res).toEqual({ status: "error", error: "Note input didn't open — check the pane" });
    expect(mockSendKeys.mock.calls).toEqual([["w1:p1", ["n"]]]);
    expect(mockSendReply).not.toHaveBeenCalled();
  });
});

describe("submitPreviewKeys — guarded single keystroke (wizard step navigation)", () => {
  it("sends the keys when the fresh buffer still shows the same dialog", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValue(paneWith(buffer({})));
    const res = await submitPreviewKeys({ ...base, preview: m, keys: ["Right"] });
    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["Right"]);
  });

  it("rejects when the dialog is gone", async () => {
    const m = model({});
    mockFetchPane.mockResolvedValue(paneWith("● Wrote the file\n  ⎿  done\n"));
    const res = await submitPreviewKeys({ ...base, preview: m, keys: ["Left"] });
    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

// node tests/mutations/derived-flush.mjs [capture-without-flush] [save-without-flush] [flush-after-clone] [flush-on-every-capture] [option-ignored] [flush-throw-stops] [missing-flush-called] [immediate-baseline-unflushed] [settled-baseline-unflushed] [entry-baseline-unflushed] [close-warning-unflushed]
// Each entry puts one bug into a scratch copy of the flush a derive engine registers
// and names the test that must then fail. With no argument every entry runs, one after
// another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/derived-flush.test.js";
const SNAPSHOT = "src/core/snapshot.js";
const DERIVED = "src/lib/derived.js";
const CALL = "  flushDerived();\n";
const CLONED = "  const clone = view.root;\n";
const SAVE = "src/core/save.js";
const SITES = "the save boundaries outside snapshot.js flush the engines: both boot baselines, the entry baseline and the close warning";
const ENTRY = "  const { forComparison, forDirty } = captureForComparisonAndDirty({ flushUndo: false });\n";
const unflushed = (line) => [line, line.replace("();", "({ flushUndo: false });")];

mutate({
  "capture-without-flush": {
    what: "a save capture clones the page without asking any engine to flush",
    file: SNAPSHOT,
    edits: [[CALL, ""]],
    test: TEST,
    name: "a save, and the sync frame of that save, hold what a flush paints from an edit made in the same task",
    expects: /Expected substring: ">5<\/output>"/,
  },
  "save-without-flush": {
    what: "the same bug, seen in the bytes a save posts",
    file: SNAPSHOT,
    edits: [[CALL, ""]],
    test: TEST,
    name: "the sapjs core: a save posts the value the engine paints from an edit made in the same task",
    expects: /Expected substring: ">5<\/output>"/,
  },
  "flush-after-clone": {
    what: "the engines flush after the page was cloned, so the paint misses the bytes",
    file: SNAPSHOT,
    edits: [[CALL, ""], [CLONED, CLONED + "  if (flushUndo) flushDerived();\n"]],
    test: TEST,
    name: "the sapjs core: an edit and a save in one task save the value the engine paints from that edit",
    expects: /Expected substring: ">5<\/output>"/,
  },
  "flush-on-every-capture": {
    what: "a capture that only reads the page flushes the engines too",
    file: SNAPSHOT,
    edits: [["  if (flushUndo) flushBoundary();\n", "  flushBoundary();\n"]],
    test: TEST,
    name: "every capture at a save boundary flushes first, and a capture that only reads the page does not",
    expects: /\+\s+"merge": 1,/,
  },
  "option-ignored": {
    what: "register keeps the repaint and drops the flush given with it",
    file: DERIVED,
    edits: [["    engines.set(repaint, flush);\n", "    engines.set(repaint, null);\n"]],
    test: TEST,
    name: "a save, and the sync frame of that save, hold what a flush paints from an edit made in the same task",
    expects: /Expected substring: ">5<\/output>"/,
  },
  "flush-throw-stops": {
    what: "a flush that throws is not caught, so it stops the save",
    file: DERIVED,
    edits: [[
      "    try {\n      flush();\n    } catch (err) {\n      console.error(\"clayjs: a derived flush failed:\", err);\n    }\n",
      "    flush();\n",
    ]],
    test: TEST,
    name: "a flush that throws is reported once, and the save still holds what the other engine's flush painted",
    expects: /the engine could not settle/,
  },
  "missing-flush-called": {
    what: "an engine that gave no flush is called as if it had, beside one that did",
    file: DERIVED,
    edits: [["    if (!flush) continue;\n", ""]],
    test: TEST,
    name: "an engine that gives no flush beside one that does: a save flushes the one, asks nothing of the other, and logs no error",
    expects: /Expected number of calls: 0\n\s*Received number of calls: 1/,
  },
  "immediate-baseline-unflushed": {
    what: "the immediate boot baseline is captured without flushing the engines",
    file: SAVE,
    edits: [unflushed("  const { forComparison: immediateContents, forDirty: immediateDirty } = captureForComparisonAndDirty();\n")],
    test: TEST,
    name: SITES,
    expects: /\+\s+"immediateBaseline": 0,/,
  },
  "settled-baseline-unflushed": {
    what: "the settled boot baseline is captured without flushing the engines",
    file: SAVE,
    edits: [["      const gateToken = boundaryToken();\n", "      const gateToken = gateCaptureToken();\n"]],
    test: TEST,
    name: SITES,
    expects: /\+\s+"settledBaseline": 0,/,
  },
  "entry-baseline-unflushed": {
    what: "the entry baseline is captured without flushing the engines",
    file: SAVE,
    edits: [[`  const token = boundaryToken();\n${ENTRY}`, `  const token = gateCaptureToken();\n${ENTRY}`]],
    test: TEST,
    name: SITES,
    expects: /\+\s+"entryBaseline": 0,/,
  },
  "close-warning-unflushed": {
    what: "the close warning's check of unsaved bytes captures without flushing the engines",
    file: "src/core/unsaved-warning.js",
    edits: [unflushed("    const current = captureForDirtyCheck();\n")],
    test: TEST,
    name: SITES,
    expects: /\+\s+"closeWarning": 0,/,
  },
});

// node tests/mutations/derived-flush-undo.mjs [no-delivery-commit] [no-delivery-command] [no-delivery-trash] [order-swapped] [delivery-without-engine] [delivered-twice] [delivered-inside-pause]
// Each entry puts one bug into a scratch copy of the save boundary's hand-over of what
// the mutation hub still holds, and names the test that must then fail. With no
// argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/derived-flush-undo.test.js";
const DERIVED = "src/lib/derived.js";
const SNAPSHOT = "src/core/snapshot.js";
const MUTATION = "src/lib/mutation.js";
const DELIVER = "  window.clay?.Mutation?.deliverDeferred?.();\n";
const GATE = "  if (!flushes.some(Boolean)) return;\n";
const CALL = "  if (flushUndo) flushDerived();\n";
const UNDO_FLUSH = "    window.clay.undo.flush();\n  }\n";
const PAUSED = "    if (this._pauseDepth > 0) return;\n";
const TAKEN = "    const batch = this._deferredChangeRecords;\n    this._deferredChangeRecords = null;\n";

mutate({
  "no-delivery-commit": {
    what: "the save boundary no longer hands the change lane what undo's drain left for a microtask, so the engine flushes before it heard of a committed edit",
    file: DERIVED,
    edits: [[DELIVER, ""]],
    test: TEST,
    name: "an edit made through clay.undo.commit, then a save in the same task: the save holds what the engine paints from it",
    expects: /Expected substring: ">5<\/output>"/,
  },
  "no-delivery-command": {
    what: "the same bug, seen through clay.undo.command",
    file: DERIVED,
    edits: [[DELIVER, ""]],
    test: TEST,
    name: "an edit made through clay.undo.command, then a save in the same task: the save holds what the engine paints from it",
    expects: /Expected substring: ">5<\/output>"/,
  },
  "no-delivery-trash": {
    what: "the same bug, seen through clay.trash",
    file: DERIVED,
    edits: [[DELIVER, ""]],
    test: TEST,
    name: "a row moved to the trash, then a save in the same task: the save holds the count the engine paints without it",
    expects: /Expected substring: ">1<\/output>"/,
  },
  "order-swapped": {
    what: "a save capture flushes undo before the engines, so what an engine's flush writes lands after the undo step the save closed",
    file: SNAPSHOT,
    edits: [[CALL, ""], [UNDO_FLUSH, UNDO_FLUSH + CALL]],
    test: TEST,
    name: "with undo running, the undo step a save closes holds the edit and what the engine's flush wrote from it, so one undo takes back both",
    expects: /\+\s+"n": "4",/,
  },
  "delivery-without-engine": {
    what: "a page with no engine flush also gets the hand-over, so its change subscribers run inside the save capture",
    file: DERIVED,
    edits: [[GATE, ""]],
    test: TEST,
    name: "a page with no engine flush: an edit made through undo reaches the page's change subscribers after the save capture, as before",
    expects: /\+\s+"inCapture": 1,/,
  },
  "delivered-twice": {
    what: "the hand-over leaves the records in the hub, so the microtask hands them over a second time",
    file: MUTATION,
    edits: [[TAKEN, "    const batch = this._deferredChangeRecords;\n"]],
    test: TEST,
    name: "a page with an engine flush: the save capture hands an edit made through undo to the page's change subscribers once",
    expects: /\+\s+"afterCapture": 2,/,
  },
  "delivered-inside-pause": {
    what: "the hand-over runs inside a pause, where pausable subscribers are skipped, and the microtask then has nothing left to give them",
    file: MUTATION,
    edits: [[PAUSED, ""]],
    test: TEST,
    name: "a save capture made inside a pause leaves an edit made through undo for after the pause, so the page's change subscribers still get it",
    expects: /\+ Array \[\]/,
  },
});

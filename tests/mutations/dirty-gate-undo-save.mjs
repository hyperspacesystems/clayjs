// node tests/mutations/dirty-gate-undo-save.mjs [counted-again] [counted-again-sap] [no-count-on-mark] [no-count-on-mark-command] [no-count-on-mark-undo] [counts-twice] [counted-when-grown] [stale-count] [nested-inherits-counted-after] [nested-inherits-counted] [nested-not-restored] [delivered-at-token] [queue-delivered-at-token]
// Each entry puts one bug into a scratch copy of how the dirty gate counts an edit made
// through undo, and names the test that must then fail. With no argument every entry
// runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/dirty-gate-undo-save.test.js";
const GATE = "src/lib/dirty-gate.js";
const MUTATION = "src/lib/mutation.js";
const SKIP = "      if (!paused && !Mutation._deliveringCounted) {\n";
const MARK = "  Mutation._countDeferred?.();\n";
const TOKEN = "export function gateCaptureToken() {\n";
const EXACT = "    const counted = !!batch && this._deferredCounted === batch.length;\n";
const RESET = "    this._deferredCounted = 0;\n";
const SET = "      this._deliveringCounted = counted;\n";
const RESTORE = "        this._deliveringCounted = outerCounted;\n";
const STUCK = /\+\s+"unsaved": "true",/;

mutate({
  "counted-again": {
    what: "the gate counts the delivery of records it already counted, so a row moved to the trash counts twice and the save in the same task cannot clear the page",
    file: GATE,
    edits: [[SKIP, "      if (!paused) {\n"]],
    test: TEST,
    name: "a row moved to the trash, then a save in the same task: the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "counted-again-sap": {
    what: "the same bug on a page the sapjs core paints, where the save's own flush delivers the held records",
    file: GATE,
    edits: [[SKIP, "      if (!paused) {\n"]],
    test: TEST,
    name: "on a page the sapjs core paints, a row moved to the trash, then a save in the same task: the save holds the new count and clears unsaved",
    expects: STUCK,
  },
  "no-count-on-mark": {
    what: "undo's mark no longer counts the records the hub holds, so their delivery counts the commit a second time",
    file: GATE,
    edits: [[MARK, ""]],
    test: TEST,
    name: "an edit made through clay.undo.commit, then a save in the same task: the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "no-count-on-mark-command": {
    what: "the same bug, seen through clay.undo.command",
    file: GATE,
    edits: [[MARK, ""]],
    test: TEST,
    name: "an edit made through clay.undo.command, then a save in the same task: the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "no-count-on-mark-undo": {
    what: "the same bug, seen through an undo",
    file: GATE,
    edits: [[MARK, ""]],
    test: TEST,
    name: "an undo, then a save in the same task: the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "counts-twice": {
    what: "the same bug, counted directly: one row moved to the trash adds two to the gate",
    file: GATE,
    edits: [[SKIP, "      if (!paused) {\n"]],
    test: TEST,
    name: "an edit made through undo counts once",
    expects: /Received: 2/,
  },
  "counted-when-grown": {
    what: "a held batch that grew after undo's mark is still taken as counted, so an edit made after the save's capture is swallowed and the page reads clean",
    file: MUTATION,
    edits: [[EXACT, "    const counted = !!batch && this._deferredCounted > 0;\n"]],
    test: TEST,
    name: "an edit made after the save's capture and held with the undo edit keeps the page dirty",
    expects: /\+\s+"unsaved": null,/,
  },
  "stale-count": {
    what: "the count of an earlier held batch outlives its delivery, so a later batch of the same size is skipped",
    file: MUTATION,
    edits: [[RESET, ""]],
    test: TEST,
    name: "an edit held after an earlier undo edit was delivered still counts",
    expects: /Received: 0/,
  },
  "nested-inherits-counted-after": {
    what: "a delivery that starts inside the delivery of counted records is taken as counted too, so an edit a page subscriber makes there is never counted",
    file: MUTATION,
    edits: [[SET, "      this._deliveringCounted = counted || outerCounted;\n"]],
    test: TEST,
    name: "an edit a page subscriber makes while the undo edit is delivered still counts",
    expects: /\+\s+"counted": 1,/,
  },
  "nested-inherits-counted": {
    what: "the same bug, seen from a subscriber that runs before the gate",
    file: MUTATION,
    edits: [[SET, "      this._deliveringCounted = counted || outerCounted;\n"]],
    test: TEST,
    name: "a subscriber that runs before the gate and makes an edit while the undo edit is delivered: the undo edit counts once and the new edit counts",
    expects: /\+\s+"counted": 1,/,
  },
  "nested-not-restored": {
    what: "a delivery nested inside the delivery of counted records leaves the flag off, so the gate, later in the outer delivery, counts the undo edit a second time",
    file: MUTATION,
    edits: [[RESTORE, ""]],
    test: TEST,
    name: "a subscriber that runs before the gate and makes an edit while the undo edit is delivered: the undo edit counts once and the new edit counts",
    expects: /\+\s+"counted": 3,/,
  },
  "delivered-at-token": {
    what: "a save hands its subscribers the records undo left for a microtask before it takes its token, so they run inside clay.save()",
    file: GATE,
    edits: [[TOKEN, TOKEN + "  Mutation.deliverDeferred();\n"]],
    test: TEST,
    name: "an edit made through undo still reaches the page's change subscribers after clay.save() returns, as before",
    expects: /\+\s+"inSave": 1,/,
  },
  "queue-delivered-at-token": {
    what: "a save hands its subscribers what the browser has queued before it takes its token, so on a page without undo they run inside clay.save()",
    file: GATE,
    edits: [[TOKEN, TOKEN + "  Mutation._deliverBeforePause();\n"]],
    test: TEST,
    name: "a page without undo: an edit reaches the page's change subscribers after clay.save() returns, as before",
    expects: /\+\s+"inSave": 1,/,
  },
});

// node tests/mutations/dirty-gate-undo-save.mjs [held-after-token] [held-after-token-sap] [held-after-token-commit] [held-after-token-command] [held-after-token-undo] [clear-swallows-later-edit] [held-dropped] [held-not-in-save] [held-delivered-twice] [queue-not-in-save]
// Each entry puts one bug into a scratch copy of how a save hands out an edit made
// through undo before it takes its dirty-gate token, and names the test that must then
// fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/dirty-gate-undo-save.test.js";
const GATE = "src/lib/dirty-gate.js";
const MUTATION = "src/lib/mutation.js";
const HELD = "      const held = this._deliverDeferredBatch();\n";
const NOT_HELD = "      const held = 0;\n";
const STUCK = /\+\s+"unsaved": "true",/;

mutate({
  "held-after-token": {
    what: "a save leaves the records undo held for their microtask, so a row moved to the trash counts after the token and the save cannot clear the page",
    file: MUTATION,
    edits: [[HELD, NOT_HELD]],
    test: TEST,
    name: "a row moved to the trash, then a save in the same task: the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "held-after-token-sap": {
    what: "the same bug on a page the sapjs core paints, where the save's own flush asks for the held records",
    file: MUTATION,
    edits: [[HELD, NOT_HELD]],
    test: TEST,
    name: "on a page the sapjs core paints, a row moved to the trash, then a save in the same task: the save holds the new count and clears unsaved",
    expects: STUCK,
  },
  "held-after-token-commit": {
    what: "the same bug, seen through clay.undo.commit",
    file: MUTATION,
    edits: [[HELD, NOT_HELD]],
    test: TEST,
    name: "an edit made through clay.undo.commit, then a save in the same task: the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "held-after-token-command": {
    what: "the same bug, seen through clay.undo.command",
    file: MUTATION,
    edits: [[HELD, NOT_HELD]],
    test: TEST,
    name: "an edit made through clay.undo.command, then a save in the same task: the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "held-after-token-undo": {
    what: "the same bug, seen through an undo",
    file: MUTATION,
    edits: [[HELD, NOT_HELD]],
    test: TEST,
    name: "an undo, then a save in the same task: the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "clear-swallows-later-edit": {
    what: "a save clears the gate whatever was counted after its token, so an edit made after the save's capture is reported saved",
    file: GATE,
    edits: [["  if (changes === token.gen) {\n    clearedAt = token.gen;\n", "  {\n    clearedAt = changes;\n"]],
    test: TEST,
    name: "an edit made after the save's capture and held with the undo edit keeps the page dirty",
    expects: /\+\s+"unsaved": null,/,
  },
  "held-dropped": {
    what: "the hub drops a held batch instead of handing it out, so an edit undo held never counts",
    file: MUTATION,
    edits: [["    if (batch && batch.length) this._handleMutations(batch);\n", ""]],
    test: TEST,
    name: "an edit held after an earlier undo edit was delivered still counts",
    expects: /Received: 0/,
  },
  "held-not-in-save": {
    what: "a save leaves the held records to their microtask, so the page's change subscribers hear of the undo edit only after clay.save() returns",
    file: MUTATION,
    edits: [[HELD, NOT_HELD]],
    test: TEST,
    name: "an edit made through undo reaches the page's change subscribers inside clay.save(), before the save reads the page, and once",
    expects: /\+\s+"inSave": 0,/,
  },
  "held-delivered-twice": {
    what: "the hub hands out a held batch and keeps it, so the subscribers are handed the undo edit again",
    file: MUTATION,
    edits: [["    this._deferredChangeRecords = null;\n", ""]],
    test: TEST,
    name: "an edit made through undo reaches the page's change subscribers inside clay.save(), before the save reads the page, and once",
    expects: /\+\s+"(inSave|after)": ([2-9]|\d\d),/,
  },
  "queue-not-in-save": {
    what: "a save leaves what the browser has queued to the browser, so on a page without undo the subscribers hear of the edit only after clay.save() returns",
    file: MUTATION,
    edits: [["      const queued = this._observer ? this._observer.takeRecords() : [];\n", "      const queued = [];\n"]],
    test: TEST,
    name: "a page without undo: an edit reaches the page's change subscribers inside clay.save(), before the save reads the page, and once",
    expects: /\+\s+"inSave": 0,/,
  },
});

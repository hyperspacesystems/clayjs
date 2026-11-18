// node tests/mutations/save-token-at-clone.mjs [token-before-boundary] [token-before-boundary-sap] [no-delivery-at-token] [sliced-token-before-boundary] [queue-left-for-browser] [held-left-for-microtask] [held-left-for-microtask-batch] [no-handover] [one-round] [no-join] [joiner-unanswered] [join-window-kept] [clear-swallows-later-edit] [gate-token-misses-held] [types-delivered-late] [join-keeps-automatic]
// Each entry puts one bug into a scratch copy of how a save takes its dirty-gate token,
// and names the test that must then fail. With no argument every entry runs, one after
// another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/save-token-at-clone.test.js";
const SAVE = "src/core/save.js";
const MUTATION = "src/lib/mutation.js";
const GATE = "src/lib/dirty-gate.js";
const BOUNDARY = "    flushBoundary();\n    Mutation.deliverDeferred();\n    return gateCaptureToken();\n";
const EARLY = "    const token = gateCaptureToken();\n    flushBoundary();\n    Mutation.deliverDeferred();\n    return token;\n";
const STUCK = /\+\s+"unsaved": "true",/;

mutate({
  "token-before-boundary": {
    what: "a save takes its token before its boundary, so the edit the hub hands out at the boundary counts after it and the save cannot clear the page",
    file: SAVE,
    edits: [[BOUNDARY, EARLY]],
    test: TEST,
    name: "a page without undo: a row removed and a save in the same task, the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "token-before-boundary-sap": {
    what: "the same bug, seen from a [sap] page whose [onmutation] save interrupts the delivery of the edit",
    file: SAVE,
    edits: [[BOUNDARY, EARLY]],
    test: TEST,
    name: "a [sap] page whose [onmutation] calls clay.save(), subscribed before the dirty gate: the save holds the painted value and clears unsaved",
    expects: STUCK,
  },
  "no-delivery-at-token": {
    what: "a save takes its token without having the hub hand out what it still owes, so the browser delivers the edit after the token",
    file: SAVE,
    edits: [["    Mutation.deliverDeferred();\n", ""]],
    test: TEST,
    name: "a page without undo: a row removed and a save in the same task, the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "sliced-token-before-boundary": {
    what: "a save prepared across tasks takes its token the old way, before anything is delivered",
    file: SAVE,
    edits: [["      const gateToken = boundaryToken(ctx.joiners);\n", "      const gateToken = gateCaptureToken();\n"]],
    test: TEST,
    name: "a page large enough to prepare its save across tasks: a row removed and a save in the same task, the save clears unsaved",
    expects: STUCK,
  },
  "queue-left-for-browser": {
    what: "the hub leaves what the browser has queued for the browser's own delivery, after the token",
    file: MUTATION,
    edits: [["      const queued = this._observer ? this._observer.takeRecords() : [];\n", "      const queued = [];\n"]],
    test: TEST,
    name: "a page without undo: a row removed and a save in the same task, the save clears unsaved and announces clay:clean",
    expects: STUCK,
  },
  "held-left-for-microtask": {
    what: "the hub leaves the records undo's drain held for their microtask, after the token",
    file: MUTATION,
    edits: [["      const held = this._deliverDeferredBatch();\n", "      const held = 0;\n"]],
    test: TEST,
    name: "a row moved to the trash, a status line written and a save in the same task: the save holds both and clears unsaved",
    expects: STUCK,
  },
  "held-left-for-microtask-batch": {
    what: "the same bug, seen through Sap.batch, whose commit holds the records",
    file: MUTATION,
    edits: [["      const held = this._deliverDeferredBatch();\n", "      const held = 0;\n"]],
    test: TEST,
    name: "Sap.batch and a save in the same task, on a page the sapjs core paints: the save holds the new count and clears unsaved",
    expects: STUCK,
  },
  "no-handover": {
    what: "a save started inside a delivery leaves the subscribers after it, the dirty gate among them, to the delivery, after the token",
    file: MUTATION,
    edits: [["    for (const delivery of [...this._deliveries].reverse()) this._notifyFrom(delivery);\n", ""]],
    test: TEST,
    name: "a page whose [onmutation] calls clay.save(), subscribed before the dirty gate: the save an edit starts clears unsaved",
    expects: STUCK,
  },
  "one-round": {
    what: "the hub hands out what the browser queued once and stops, so a subscriber's write in reply is delivered after the token",
    file: MUTATION,
    edits: [["const DELIVERY_ROUNDS = 8;\n", "const DELIVERY_ROUNDS = 1;\n"]],
    test: TEST,
    name: "a change subscriber that writes when it is handed an edit: the save holds that write and clears unsaved",
    expects: STUCK,
  },
  "no-join": {
    what: "a save asked for inside another save's boundary runs on its own, finds the outer save in progress, and the awaited save is the one that gives up",
    file: SAVE,
    edits: [["  if (joiningSave) return joinSave(callback, options.kind === 'explicit');\n", ""]],
    test: TEST,
    name: "a row moved to the trash and an awaited save, on a [sap] page whose [onmutation] saves too: the awaited save writes, and the [onmutation] save joins it",
    expects: /\+\s+"msg": "Save already in progress",/,
  },
  "joiner-unanswered": {
    what: "a joined save hands its callback the outer save's result but never settles its promise",
    file: SAVE,
    edits: [["      if (typeof callback === 'function') callback(result);\n      resolve(result);\n", "      if (typeof callback === 'function') callback(result);\n"]],
    test: TEST,
    name: "an edit and an awaited save on a page whose [onmutation] saves too: the [onmutation] save joins the awaited one, and the next save runs on its own",
    expects: /"answers": Array \[\n\s+"Saved",\n-\s+"Saved",/,
  },
  "join-window-kept": {
    what: "the join window stays open after the boundary, so the next save joins a save that has already answered and never captures",
    file: SAVE,
    edits: [["    joiningSave = outer;\n", ""]],
    test: TEST,
    name: "an edit and an awaited save on a page whose [onmutation] saves too: the [onmutation] save joins the awaited one, and the next save runs on its own",
    expects: /Expected length: 2\n\s*Received length: 1/,
  },
  "clear-swallows-later-edit": {
    what: "a save clears the gate whatever was counted after its token, so an edit made after the save read the page is reported saved",
    file: GATE,
    edits: [["  if (changes === token.gen) {\n    clearedAt = token.gen;\n", "  {\n    clearedAt = changes;\n"]],
    test: TEST,
    name: "an edit made after clay.save() returned is not in the bytes it wrote and keeps the page dirty",
    expects: /\+\s+"unsaved": null,/,
  },
  "gate-token-misses-held": {
    what: "a draft's token and check take only what the browser queued, so an edit made through the trash just before counts again after the token and the draft reads as changed",
    file: GATE,
    edits: [["  if (Mutation._pauseDepth > 0) Mutation._deliverBeforePause();\n  else Mutation.deliverDeferred();\n", "  Mutation._deliverBeforePause();\n"]],
    test: TEST,
    name: "a draft token taken right after an edit made through the trash",
    expects: /Expected: true/,
  },
  "types-delivered-late": {
    what: "each type's delivery is listed only as it starts, so a save started by an anyChange subscriber takes its token before the later types hear of the edit",
    file: MUTATION,
    edits: [["    for (let i = deliveries.length - 1; i >= 0; i--) this._deliveries.push(deliveries[i]);\n    try {\n      for (const delivery of deliveries) {\n", "    try {\n      for (const delivery of deliveries) {\n        this._deliveries.push(delivery);\n"]],
    test: TEST,
    name: "a subscriber to added and removed elements that writes when an [onmutation] save is started: the save holds that write and clears unsaved",
    expects: STUCK,
  },
  "join-keeps-automatic": {
    what: "an explicit save that joins an automatic one leaves it automatic, so it skips an edit only an explicit save writes",
    file: SAVE,
    edits: [["      if (soonQueued.explicit) explicit = true;\n", ""]],
    test: TEST,
    name: "an explicit save asked for inside an automatic save's boundary makes it write an edit only an explicit save writes",
    expects: /toEqual/,
  },
});

// node tests/mutations/derived-flush-in-delivery.mjs [no-finish] [cursor-copied] [frames-kept] [no-finish-without-engine] [no-finish-nested]
// Each entry puts one bug into a scratch copy of how a save boundary hands the rest of
// the subscribers the batch being delivered, and names the test that must then fail.
// With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/derived-flush-in-delivery.test.js";
const MUTATION = "src/lib/mutation.js";
const FINISH = "    for (const delivery of [...this._deliveries].reverse()) this._notifyFrom(delivery);\n";
const POP = "      this._deliveries.splice(this._deliveries.length - deliveries.length, deliveries.length);\n";

mutate({
  "no-finish": {
    what: "a save boundary no longer hands the rest of the subscribers the batch being delivered, so the engine flushes before it heard of the edit an [onmutation] save follows",
    file: MUTATION,
    edits: [[FINISH, ""]],
    test: TEST,
    name: "a page whose [onmutation] calls clay.save(): the save holds what the engine paints from the edit",
    expects: /Expected substring: ">5<\/output>"/,
  },
  "cursor-copied": {
    what: "the hand-over walks a copy of the delivery's cursor, so the delivery goes on from where it was and hands the same subscribers the batch a second time",
    file: MUTATION,
    edits: [[FINISH, "    for (const delivery of [...this._deliveries].reverse()) this._notifyFrom({ ...delivery });\n"]],
    test: TEST,
    name: "the subscribers a save hands the batch to are not handed it again when the delivery goes on",
    expects: /\+\s+"batches": [2-9],/,
  },
  "frames-kept": {
    what: "a finished delivery stays on the stack, so a later save boundary hands a subscriber that came after it an old batch",
    file: MUTATION,
    edits: [[POP, ""]],
    test: TEST,
    name: "the subscribers a save hands the batch to are not handed it again when the delivery goes on",
    expects: /\+\s+"batches": [2-9],/,
  },
  "no-finish-without-engine": {
    what: "the same hand-over, missing on a page with no engine flush: the subscribers after an [onmutation] save hear of the edit only after its capture",
    file: MUTATION,
    edits: [[FINISH, ""]],
    test: TEST,
    name: "a page with no engine flush: a save from a change subscriber hands the subscribers after it the batch before it reads the page, and once",
    expects: /\+\s+"inCapture": 0,/,
  },
  "no-finish-nested": {
    what: "the same hand-over, missing for a save started two deliveries deep: the dirty gate counts both edits after the token, and the page stays dirty",
    file: MUTATION,
    edits: [[FINISH, ""]],
    test: TEST,
    name: "a save started in a delivery nested inside the delivery of an undo edit, on a page with an engine flush: the save holds both edits and leaves the page clean",
    expects: /\+\s+"unsaved": "true",/,
  },
});

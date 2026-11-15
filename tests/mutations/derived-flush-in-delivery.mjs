// node tests/mutations/derived-flush-in-delivery.mjs [no-finish] [no-finish-trash] [cursor-copied] [frames-kept] [finish-without-engine] [finish-without-flag]
// Each entry puts one bug into a scratch copy of how a save boundary hands the rest of
// the subscribers the batch being delivered, and names the test that must then fail.
// With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/derived-flush-in-delivery.test.js";
const MUTATION = "src/lib/mutation.js";
const DERIVED = "src/lib/derived.js";
const FINISH = [
  "    for (const delivery of [...this._deliveries].reverse()) {\n",
  "      const previousCounted = this._deliveringCounted;\n",
  "      this._deliveringCounted = delivery.counted;\n",
  "      try {\n",
  "        this._notifyFrom(delivery);\n",
  "      } finally {\n",
  "        this._deliveringCounted = previousCounted;\n",
  "      }\n",
  "    }\n",
].join("");
const FROM = "        this._notifyFrom(delivery);\n";
const POP = "      this._deliveries.pop();\n";
const GATE = "  if (!flushes.some(Boolean)) return;\n";
const FLAG = "      this._deliveringCounted = delivery.counted;\n";

mutate({
  "no-finish": {
    what: "a save boundary no longer hands the rest of the subscribers the batch being delivered, so the engine flushes before it heard of the edit an [onmutation] save follows",
    file: MUTATION,
    edits: [[FINISH, ""]],
    test: TEST,
    name: "a page whose [onmutation] calls clay.save(): the save holds what the engine paints from the edit",
    expects: /Expected substring: ">5<\/output>"/,
  },
  "no-finish-trash": {
    what: "the same bug, seen through a row moved to the trash, whose delivery the [onmutation] save interrupts",
    file: MUTATION,
    edits: [[FINISH, ""]],
    test: TEST,
    name: "a row moved to the trash and a save in the same task, on a page whose [onmutation] saves too: the save that goes out holds the new count",
    expects: /Expected substring: ">1<\/output>"/,
  },
  "cursor-copied": {
    what: "the hand-over walks a copy of the delivery's cursor, so the delivery goes on from where it was and hands the same subscribers the batch a second time",
    file: MUTATION,
    edits: [[FROM, "        this._notifyFrom({ ...delivery });\n"]],
    test: TEST,
    name: "the subscribers a save hands the batch to are not handed it again when the delivery goes on",
    expects: /\+\s+"batches": 2,/,
  },
  "frames-kept": {
    what: "a finished delivery stays on the stack, so a later save boundary hands a subscriber that came after it an old batch",
    file: MUTATION,
    edits: [[POP, ""]],
    test: TEST,
    name: "the subscribers a save hands the batch to are not handed it again when the delivery goes on",
    expects: /\+\s+"batches": [2-9],/,
  },
  "finish-without-engine": {
    what: "a page with no engine flush also gets the hand-over, so the subscribers after an [onmutation] save run inside its capture",
    file: DERIVED,
    edits: [[GATE, ""]],
    test: TEST,
    name: "a page with no engine flush: a save from a change subscriber leaves the subscribers after it to the delivery, as before",
    expects: /\+\s+"inCapture": 1,/,
  },
  "finish-without-flag": {
    what: "the hand-over runs an outer delivery's subscribers with the inner delivery's count flag, so the gate counts an undo edit it already counted",
    file: MUTATION,
    edits: [[FLAG, ""]],
    test: TEST,
    name: "a save boundary reached in a delivery nested inside the delivery of an undo edit: the undo edit still counts once",
    expects: /\+\s+"counted": 3,/,
  },
});

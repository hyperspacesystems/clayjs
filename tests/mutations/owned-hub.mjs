// node tests/mutations/owned-hub.mjs [records-not-dropped] [raw-lane-unfiltered] [raw-drain-unfiltered] [failed-revision-quiet] [deferred-not-dropped] [deferred-copy-filtered] [hand-over-skipped]
// Each entry puts one bug into a scratch copy of the mutation hub and names the test
// that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/owned-region-hub.test.js";
const HUB = "src/lib/mutation.js";
const DEFERRED = "tests/unit/owned-region-deferred.test.js";
const THROUGH_UNDO = "an edit inside an owned region made through undo, then a save: before its flush the engine hears the region once as an owned change and no record from inside it, as a direct edit does";

mutate({
  "records-not-dropped": {
    what: "records inside an owned region go on to the generic change lane",
    file: HUB,
    edits: [["        if (ownedRoot) { ownedTouched.add(ownedRoot); continue; }", "        if (ownedRoot) { ownedTouched.add(ownedRoot); }"]],
    test: TEST,
    name: "writes that do not move the revision tell nobody",
    expects: /Expected: 0\n\s*Received: 1/,
  },
  "raw-lane-unfiltered": {
    what: "the raw lane hands undo every record, those inside a region included",
    file: HUB,
    edits: [["    const records = outsideOwned(all);", "    const records = all;"]],
    test: TEST,
    name: "the raw lane that undo records from gets nothing from inside an owned region",
    expects: /Expected: 1\n\s*Received: 4\d/,
  },
  "raw-drain-unfiltered": {
    what: "a raw subscriber that pulls its records gets those inside a region too",
    file: HUB,
    edits: [["    const raw = this._rawSubscribers.length ? outsideOwned(pulled) : pulled;", "    const raw = pulled;"]],
    test: TEST,
    name: "the raw lane that undo records from gets nothing from inside an owned region",
    expects: /\+\s+null,/,
  },
  "failed-revision-quiet": {
    what: "a revision that throws in the hub counts as no change",
    file: "src/lib/owned-regions.js",
    edits: [["    report(region, 'revision', error)\n    return true\n", "    report(region, 'revision', error)\n    return false\n"]],
    test: TEST,
    name: "a revision that throws counts as a change every time and is reported once",
    expects: /Expected: 2\n\s*Received: 0/,
  },
  "deferred-not-dropped": {
    what: "the save boundary hands the engine what undo's drain left for a microtask with the records inside a region still in it",
    file: HUB,
    edits: [["        if (ownedRoot) { ownedTouched.add(ownedRoot); continue; }", "        if (ownedRoot) { ownedTouched.add(ownedRoot); }"]],
    test: DEFERRED,
    name: THROUGH_UNDO,
    expects: /\+\s+"characterData td",/,
  },
  "deferred-copy-filtered": {
    what: "undo's drain filters the change lane's copy as it filters its own, so an edit made through undo never reports its region",
    file: HUB,
    edits: [["        this._deferChangeLane(pulled);", "        this._deferChangeLane(raw);"]],
    test: DEFERRED,
    name: THROUGH_UNDO,
    expects: /-\s+"owned table",/,
  },
  "hand-over-skipped": {
    what: "the save boundary does not hand over what undo's drain left, so the engine flushes before it heard of the edit",
    file: "src/lib/derived.js",
    edits: [["window.clay?.Mutation?.deliverDeferred?.();", ""]],
    test: DEFERRED,
    name: THROUGH_UNDO,
    expects: /\+\s+Array \[\],/,
  },
});

// node tests/mutations/owned-conflict.mjs [always-quiet] [overwrite-allowed]
// Each entry puts one bug into a scratch copy of the save conflict handling and names
// the test that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/owned-region-conflict.test.js";
const SAVE = "src/core/save.js";

mutate({
  "always-quiet": {
    what: "a refusal is handed to the owners even when something outside their regions is unsaved",
    file: SAVE,
    edits: [["  return withoutQuietRevisions(current) === withoutQuietRevisions(lastSavedDirty);", "  return true;"]],
    test: TEST,
    name: "a refusal with a change outside the region as well is the conflict it is today",
    expects: /expect\(received\)\.toEqual\(expected\)/,
  },
  "overwrite-allowed": {
    what: "clay.save.overwrite writes over a version the owners were asked to resolve",
    file: SAVE,
    edits: [["  if (!conflictHold && ownersResolveConflicts()) {\n    const refused", "  if (false) {\n    const refused"]],
    test: TEST,
    name: "a refusal with every unsaved change inside regions that take conflicts tells the owner and shows no conflict",
    expects: /"code": "owned-conflict"/,
  },
});

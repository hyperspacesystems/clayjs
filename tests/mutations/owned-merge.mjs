// node tests/mutations/owned-merge.mjs [region-not-opaque] [divergence-dropped] [focus-restored] [base-withheld]
// Each entry puts one bug into a scratch copy of the live sync merge and names the test
// that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/owned-region-merge.test.js";
const SYNC = "src/sync/live-sync.js";

mutate({
  "region-not-opaque": {
    what: "the generic merge walks into an owned region",
    file: SYNC,
    edits: [["el.matches(FREEZE_SELECTOR) || matchesOwnedSelector(el) || ", "el.matches(FREEZE_SELECTOR) || "]],
    test: TEST,
    name: "clean tab: the owner takes the file's rows, the generic merge takes the rest and never enters the region",
    expects: /Expected: 4\n\s*Received: 0/,
  },
  "divergence-dropped": {
    what: "the owner's answer that the region still holds unsaved work is ignored",
    file: SYNC,
    edits: [["      if (owned?.diverged) report.localDiverged = true;\n", ""]],
    test: TEST,
    name: "dirty tab: a peer's row lands, the unsaved cell stays, and only the tab's own save records it as saved",
    expects: /expect\(received\)\.toBe\(expected\)/,
  },
  "focus-restored": {
    what: "the merge reads and restores focus that sits inside an owned region",
    file: SYNC,
    edits: [[" && !ownedRootOf(document.activeElement),", ","]],
    test: TEST,
    name: "focus inside an owned region is left to its owner",
    expects: /Expected: 0\n\s*Received: [1-9]/,
  },
  "base-withheld": {
    what: "the owner is given no base version",
    file: SYNC,
    edits: [["          return ownedBase;", "          return null;"]],
    test: TEST,
    name: "clean tab: the owner takes the file's rows, the generic merge takes the rest and never enters the region",
    expects: /-\s+"base": "a2",\n\+\s+"base": null,/,
  },
});

// node tests/mutations/owned-capture.mjs [marker-in-file] [comparison-serializes] [frozen-root-owned] [failed-revision-clean]
//   [purpose-dropped] [recovery-as-save]
// Each entry puts one bug into a scratch copy of the capture path and names the test
// that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/owned-region-capture.test.js";
const SNAPSHOT = "src/core/snapshot.js";
const REGIONS = "src/lib/owned-regions.js";

mutate({
  "marker-in-file": {
    what: "the clone serializer returns the marker instead of the owner's bytes",
    file: SNAPSHOT,
    edits: [["  return ownedBytes(serializeCloneRaw(clone));", "  return serializeCloneRaw(clone);"]],
    test: TEST,
    name: "a registered region is written by its owner in every byte output and never by outerHTML",
    expects: /"recoveryClone",\n-\s+true,\n\+\s+false,/,
  },
  "comparison-serializes": {
    what: "a comparison capture asks the owner for its bytes",
    file: SNAPSHOT,
    edits: [["  const pins = pinOwnedRegions(owned, purpose);", "  const pins = pinOwnedRegions('bytes', purpose);"]],
    test: TEST,
    name: "a save capture calls serialize once per region and a comparison capture never calls it",
    expects: /-\s+0,\n\+\s+6,/,
  },
  "frozen-root-owned": {
    what: "a root under freeze is still owned",
    file: REGIONS,
    edits: [[" && !root.closest(OWNED_FROZEN_SELECTOR)\n}", "\n}"]],
    test: TEST,
    name: "a root with freeze on it or above it is not owned",
    expects: /-\s+0,\n-\s+0,\n\+\s+2,\n\+\s+2,/,
  },
  "failed-revision-clean": {
    what: "a revision that throws writes the same text every time, so the region reads as saved",
    file: REGIONS,
    edits: [["    return `!${++failures}`", "    return ''"]],
    test: TEST,
    name: "a revision that throws never reads as saved and is reported once",
    expects: /expect\(received\)\.not\.toBe\(expected\)/,
  },
  "purpose-dropped": {
    what: "the owner is asked for the file view whatever the capture writes, so a recovery copy holds the save form",
    file: REGIONS,
    edits: [["      const bytes = region.serialize(root, { purpose })", "      const bytes = region.serialize(root, { purpose: 'save' })"]],
    test: TEST,
    name: "each capture asks the owner for the view it writes",
    expects: /Expected substring: "<td>sync<\/td>"/,
  },
  "recovery-as-save": {
    what: "a recovery page is captured as a save, so it keeps only what a save would write",
    file: SNAPSHOT,
    edits: [["captureSaveClone({ flushUndo: false, authored: false, purpose: 'recovery' })", "captureSaveClone({ flushUndo: false, authored: false })"]],
    test: TEST,
    name: "each capture asks the owner for the view it writes",
    expects: /Expected substring: "<td>recovery<\/td>"/,
  },
});

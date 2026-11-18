// node tests/mutations/owned-merge-hold.mjs [no-auto-clear] [stamp-adopted] [base-moves-on]
// Each entry puts one bug into a scratch copy of the failed merge handling and names the
// test that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/owned-region-merge.test.js";
const SYNC = "src/sync/live-sync.js";
const NAME = "a merge that throws keeps the region and holds this tab as a save conflict until a later version merges";

mutate({
  "no-auto-clear": {
    what: "a later version that merges does not clear the hold a failed merge placed",
    file: SYNC,
    edits: [[
      "    if (ownedMerged) edit?.ownedMergeRecovered(etag);\n    this._saveAfterMerge(diverged, typedDuringWait);\n    // A disk frame from a writer that does not paint",
      "    this._saveAfterMerge(diverged, typedDuringWait);\n    // A disk frame from a writer that does not paint",
    ]],
    test: TEST,
    name: NAME,
    expects: /Expected: false\n\s*Received: true/,
  },
  "stamp-adopted": {
    what: "this tab takes the stamp of a version its region did not merge",
    file: SYNC,
    edits: [[
      "      this._setDiskBase(html, ticket);\n\n      window.scrollTo(scrollX, scrollY);\n\n      // The stamp of section 6, adopted here and nowhere else: this is the moment\n      // the bytes it describes reached this tab. It is taken after a merge that\n      // kept local edits too, because the merge still incorporates the disk\n      // bytes, and the convergence save at the bottom needs a stamp the host\n      // will accept or the merge is refused and lost.\n      //\n      // A frame with no stamp (an older host, or the content-less fetch fallback\n      // on a host that does not answer the version question) leaves this alone,\n      // and the listener in etag.js falls back to asking the host. A save\n      // accepted since this frame captured already recorded a newer stamp, and\n      // this body, older than that save, must not rewind it — nor clear it.\n      ownedMerged = ownedFailed === false;\n      if (!ownedFailed && !(this._acceptedSaveTicket > ticket)) {",
      "      this._setDiskBase(html, ticket);\n\n      window.scrollTo(scrollX, scrollY);\n\n      ownedMerged = ownedFailed === false;\n      if (!(this._acceptedSaveTicket > ticket)) {",
    ]],
    test: TEST,
    name: NAME,
    expects: /Expected: true\n\s*Received: false/,
  },
  "base-moves-on": {
    what: "after a failed merge the owner is given the base of a version its region never merged",
    file: SYNC,
    edits: [["      if (unmergedBase === null && typeof base === 'string') this._ownedUnmerged.set(source, base);\n", ""]],
    test: TEST,
    name: NAME,
    expects: /\+\s+"peer a2",/,
  },
});

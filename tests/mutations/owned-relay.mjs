// node tests/mutations/owned-relay.mjs [whole-file-parsed] [bodies-not-kept]
// Each entry puts one bug into a scratch copy of the relay of a landed save and names
// the test that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/owned-region-relay.test.js";
const SYNC = "src/sync/live-sync.js";
const NAME = "the sent bytes check of a landed save parses the page around the region and not the region's bytes";

mutate({
  "whole-file-parsed": {
    what: "the sent bytes check parses both whole strings, region included",
    file: SYNC,
    edits: [["  const [mine, theirs] = shells && shells[0] !== null && shells[1] !== null ? shells : [html, sent];", "  const [mine, theirs] = [html, sent];"]],
    test: TEST,
    name: NAME,
    expects: /expect\(received\)\.toBeLessThan\(expected\)/,
  },
  "bodies-not-kept": {
    what: "the capture a save relays from keeps no record of its region bytes",
    file: SYNC,
    edits: [["        ownedBodies: ownedBodies(clone),\n", ""]],
    test: TEST,
    name: NAME,
    expects: /Received: undefined/,
  },
});

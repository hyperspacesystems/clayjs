// node tests/mutations/owned-perf.mjs [comparison-serializes]
// Puts one bug into a scratch copy of the capture path and names the perf fixture test
// that must then fail on a count, not on a clock.
import { mutate } from "./harness.mjs";

mutate({
  "comparison-serializes": {
    what: "a comparison capture asks the owner for its bytes",
    file: "src/core/snapshot.js",
    edits: [["  const pins = pinOwnedRegions(owned, purpose, context !== null);", "  const pins = pinOwnedRegions('bytes', purpose, context !== null);"]],
    test: "tests/perf/owned-region-save.test.js",
    jestArgs: ["--testMatch", "**/tests/perf/**/*.test.js"],
    name: "an owned region of 20,000 cells saves and compares in the time of an empty one",
    expects: /Expected: 33\n\s*Received: 64/,
  },
});

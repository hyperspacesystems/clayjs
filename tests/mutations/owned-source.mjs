// node tests/mutations/owned-source.mjs [session-asked] [render-runs] [repair-runs]
// Each entry puts one bug into a scratch copy of the source plugin and names the test
// that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/owned-region-source.test.js";
const SESSION = "src/source/session.js";

mutate({
  "session-asked": {
    what: "a save on a page with a region asks for the source session",
    file: "src/plugins/source.js",
    edits: [["  if (!admitted || answered || hasOwnedRegions()) return null;", "  if (!admitted || answered) return null;"]],
    test: TEST,
    name: "a save on a page with a region asks for no source session, and one without a region does",
    expects: /Expected: null/,
  },
  "render-runs": {
    what: "an installed session renders a save while a region is registered",
    file: SESSION,
    edits: [["  if (!state.installed || hasOwnedRegions()) return today;", "  if (!state.installed) return today;"]],
    test: TEST,
    name: "an installed session stands aside while a region is registered and comes back after",
    expects: /Expected substring: "<body class=\\"page\\">"/,
  },
  "repair-runs": {
    what: "an installed session repairs its map after a merge while a region is registered",
    file: SESSION,
    edits: [["  }\n  if (!state.installed || hasOwnedRegions()) return;\n  if (detail && detail.source === 'disk'", "  }\n  if (!state.installed) return;\n  if (detail && detail.source === 'disk'"]],
    test: TEST,
    name: "an installed session stands aside while a region is registered and comes back after",
    expects: /expect\(received\)\.toBe\(expected\)/,
  },
});

// node tests/mutations/owned-registry.mjs [not-on-clay-region] [empty-region-written] [file-paints-count-region]
// Each entry puts one bug into a scratch copy of the owned region registry and names the
// test that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/owned-region-registry.test.js";

mutate({
  "not-on-clay-region": {
    what: "clay.region has no own function",
    file: "src/lib/region-policy.js",
    edits: [["  addRegionToken,\n  own,\n", "  addRegionToken,\n"]],
    test: TEST,
    name: "clay.region.own is the registry's function on the one region shape",
    expects: /Received: undefined/,
  },
  "empty-region-written": {
    what: "a marker that holds no bytes resolves to an empty region instead of refusing",
    file: "src/lib/owned-regions.js",
    edits: [["    if (hole.kind !== 'b') throw fail('This capture holds no bytes for its owned regions', 'owned-region-unpinned')\n", ""]],
    test: TEST,
    name: "a marker with no bytes or with missing text refuses instead of writing an empty region",
    expects: /Received function did not throw/,
  },
  "file-paints-count-region": {
    what: "the painted values of a file include those inside a region",
    file: "src/lib/derived.js",
    edits: [["  for (const { element } of ownedRootsIn(doc)) element.replaceChildren();\n", ""]],
    test: TEST,
    name: "the painted values of a file leave the roots of a registered region out",
    expects: /Expected: "p #hi"\n\s*Received: "p #hi td #stale"/,
  },
});

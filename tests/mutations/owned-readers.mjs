// node tests/mutations/owned-readers.mjs [demo-stores-marker] [page-paints-serialize]
// Each entry puts one bug into a scratch copy of a reader of the capture and names the
// test that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/owned-region-readers.test.js";

mutate({
  "demo-stores-marker": {
    what: "the demo plugin stores the capture's body as it finds it",
    file: "src/plugins/demo.js",
    edits: [[
      '  snapshotBody = ownedBytes(event.detail.documentElement.querySelector("body")?.outerHTML || "") || null;',
      '  snapshotBody = event.detail.documentElement.querySelector("body")?.outerHTML || null;',
    ]],
    test: TEST,
    name: "the demo plugin stores the owner's bytes and no marker",
    expects: /Expected substring: not "clay-owned"/,
  },
  "page-paints-serialize": {
    what: "reading the page's painted values asks the owner for its bytes",
    file: "src/core/save.js",
    edits: [["captureSaveClone({ flushUndo: false, owned: 'revision' })", "captureSaveClone({ flushUndo: false })"]],
    test: TEST,
    name: "the painted values of the page leave region roots out, as the file side does, and ask the owner for no bytes",
    expects: /Expected: 0\n\s*Received: 1/,
  },
});

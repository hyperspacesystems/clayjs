// node tests/mutations/order-keys.mjs [keys-trailing-zero] [second-copy] [prosemirror-import]
// Each entry puts one bug into a scratch copy of the order key code and names the test
// that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/order-keys.test.js";
const KEYS = "src/lib/order-keys.js";
const MODEL = "src/page/model.js";

mutate({
  "keys-trailing-zero": {
    what: "a key may end in 0, so a0 counts as a key and keyBetween no longer refuses it",
    file: KEYS,
    edits: [["const VALID_KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;", "const VALID_KEY = /^[0-9A-Za-z]*[0-9A-Za-z]$/;"]],
    test: TEST,
    name: "isKey and keyBetween match the vectors the sapjs grid codec is held to",
    expects: /"a0",/,
  },
  "second-copy": {
    what: "the page model exports its own isKey instead of the shared one",
    file: MODEL,
    edits: [[
      'import { isKey, keyBetween, keysBetween } from "../lib/order-keys.js";',
      'import { isKey as sharedIsKey, keyBetween, keysBetween } from "../lib/order-keys.js";\nconst isKey = (key) => sharedIsKey(key);',
    ]],
    test: TEST,
    name: "the page model exports the shared key functions themselves",
    expects: /"isKey",\n-\s+true,\n\+\s+false,/,
  },
  "prosemirror-import": {
    what: "the shared module imports the ProseMirror bundle",
    file: KEYS,
    edits: [["const DIGITS = ", 'import "../vendor/prosemirror.vendor.js";\nconst DIGITS = ']],
    test: TEST,
    name: "the shared module's graph has no ProseMirror, page module or vendored library, and the page model's graph has all three",
    expects: /\+\s+"src\/vendor\/prosemirror\.vendor\.js",/,
  },
});

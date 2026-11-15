// node tests/mutations/derive-plugins.mjs [no-wait] [loader-not-set] [table-ignored] [core-not-loaded] [full-engine-skipped] [failure-rejects] [page-loader-dropped] [prototype-names]
// Each entry puts one bug into a scratch copy of plugins/derive.js and names the test
// that must then fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/derive-plugins.test.js";
const DERIVE = "src/plugins/derive.js";
const WAIT = "  await plugins.ready(document);\n";
const LOADER = "  plugins.loader = (name, facts) => (Object.hasOwn(SAP_PLUGINS, name) ? SAP_PLUGINS[name]() : pageLoader?.(name, facts));\n";
const CORE = '  if (!fullSapjs()) await import("../vendor/sap-core.vendor.js");\n';
const TABLE_TEST = "the loader derive gives the engine answers from this release's table, and a plugin it serves installs";

mutate({
  "no-wait": {
    what: "derive asks the engine for the page's plugins and does not wait, so the page mounts and clay.ready resolves before the plugin installed",
    file: DERIVE,
    edits: [[WAIT, "  plugins.ready(document);\n"]],
    test: TEST,
    name: "boot: clay.ready and the first pass wait for a plugin the page asks for, and the first pass paints with it",
    expects: /Expected: false\n\s*Received: true/,
  },
  "loader-not-set": {
    what: "derive never gives the engine a loader, so every plugin would come from a script tag",
    file: DERIVE,
    edits: [[LOADER, ""]],
    test: TEST,
    name: TABLE_TEST,
    expects: /Expected: "function"\n\s*Received: "object"/,
  },
  "table-ignored": {
    what: "the loader answers undefined for every name, this release's plugins included",
    file: DERIVE,
    edits: [[LOADER, "  plugins.loader = () => undefined;\n"]],
    test: TEST,
    name: TABLE_TEST,
    expects: /Expected: \{"default"[^\n]*\n\s*Received: undefined/,
  },
  "core-not-loaded": {
    what: "derive no longer imports the core on a page with no full sapjs",
    file: DERIVE,
    edits: [[CORE, ""]],
    test: TEST,
    name: "a page that asks for no plugin: derive loads the core, ready resolves, and the page mounts as before",
    expects: /Cannot read properties of undefined \(reading 'core'\)/,
  },
  "full-engine-skipped": {
    what: "derive stays idle when full sapjs has the page, as it did before plugins",
    file: DERIVE,
    edits: [[CORE, '  if (fullSapjs()) return;\n  await import("../vendor/sap-core.vendor.js");\n']],
    test: TEST,
    needs: ["entries/sap.js"],
    name: "full sapjs has the page: derive loads no core, and the full engine gets the same table and the same wait",
    expects: /\+ Promise \{\}/,
  },
  "failure-rejects": {
    what: "derive waits on the plugin itself, so a plugin that cannot load rejects ready",
    file: DERIVE,
    edits: [[WAIT, '  await plugins.load("tally");\n']],
    test: TEST,
    name: "a plugin this release does not carry and the engine cannot find: ready still resolves, and the engine names the failure",
    expects: /Received promise rejected instead of resolved/,
  },
  "page-loader-dropped": {
    what: "derive replaces a loader the page set, so a plugin only the page could serve falls back to a script tag",
    file: DERIVE,
    edits: [[" : pageLoader?.(name, facts));", " : undefined);"]],
    test: TEST,
    name: "a loader the page set before derive ran still answers every name this release does not carry",
    expects: /Expected: \{"default"[^\n]*\n\s*Received: undefined/,
  },
  "prototype-names": {
    what: "derive looks a name up through the prototype chain, so toString, constructor and valueOf answer as plugins",
    file: DERIVE,
    edits: [["Object.hasOwn(SAP_PLUGINS, name) ?", "SAP_PLUGINS[name] ?"]],
    test: TEST,
    name: "a name that is only on Object.prototype is not one this release carries",
    expects: /\+\s+"\[object Object\]",/,
  },
});

// node tests/mutations/derived-plugin-rules.mjs [merge-sees-every-rule] [merge-sees-no-rule] [repaints-attr-static] [repaints-text-static] [strip-repainted-static] [repaints-attr-without-engine] [repaints-text-without-engine] [strip-repainted-without-engine] [hub-asks-merge-question] [compare-asks-merge-question] [signature-asks-merge-question] [signature-without-plugins] [merge-strips-every-rule] [merge-keeps-every-painted-text] [merge-ignores-every-painted-attr] [merge-never-repaints-plugin] [merge-strips-without-engine]
// Each entry puts one bug into a scratch copy of the code that answers a plugin's
// ownership rules, or of a place that asks them, and names the test that must then
// fail. With no argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/derived-plugin-rules.test.js";
const DERIVED = "src/lib/derived.js";
const SNAPSHOT = "src/core/snapshot.js";
const LIVE = "src/sync/live-sync.js";

const NOT_INSTALLED = "while a plugin is not installed, its output is never an edit and a merge takes it as content";
const INSTALLED_CASE = "once the plugin is installed, a merge leaves its output out because this tab paints it again";
const NO_ENGINE = "with no engine in the tab, a merge takes every painted value as content";
const NO_PLUGIN = "a merge into a tab with the engine and no plugin shows the sender's plugin output";
const PLUGIN = "the same merge into a tab with the plugin installed shows the total it paints again itself";
const LATE = "a plugin that installs after the baseline and repaints does not make the page dirty";
const HEAL_RIGHT = "a plugin that installs between the file's paint signature and the heal does not save a file that was already right";
const HEAL_STALE = "a plugin that installs late and repaints a stale file still heals it with one save";

// A table case's diff names the answer that went wrong on its own line.
const answered = (key, value) => new RegExp(`\\+\\s+"${key}": ${value},`);
// A merge case's diff names the value the page shows instead.
const shows = (key, value) => new RegExp(`\\+\\s+"${key}": "${value}",`);

const INSTALLED = "const installed = (plugin) => !!window.Sap?.plugins?.has?.(plugin);";
const SIGNATURE_WALK_END = '  });\n  return parts.join("\\u0001");';
const LIVE_IMPORT = "import { repaintsAttr, repaintsText, stripRepainted, repaintDerived, paintSignatureOfHtml } from '../lib/derived.js';";
const liveImportWith = (names) => LIVE_IMPORT.replace("repaintDerived,", `repaintDerived, ${names},`);

mutate({
  "merge-sees-every-rule": {
    what: "a merge counts a plugin as installed when it is not, so it leaves out what that plugin paints",
    file: DERIVED,
    edits: [[INSTALLED, "const installed = () => true;"]],
    test: TEST,
    name: NOT_INSTALLED,
    expects: answered("merge: text of the total", true),
  },
  "merge-sees-no-rule": {
    what: "a merge counts no plugin as installed, so it takes the sender's output over an installed plugin's",
    file: DERIVED,
    edits: [[INSTALLED, "const installed = () => false;"]],
    test: TEST,
    name: INSTALLED_CASE,
    expects: answered("merge: text of the total", false),
  },
  "repaints-attr-static": {
    what: "repaintsAttr asks every rule, so a merge leaves out an attribute of a plugin that is not installed",
    file: DERIVED,
    edits: [["ownsAttr(el, name, null, installed)", "ownsAttr(el, name)"]],
    test: TEST,
    name: NOT_INSTALLED,
    expects: answered("merge: data-sum on the total", true),
  },
  "repaints-text-static": {
    what: "repaintsText asks every rule, so a merge keeps this tab's text where a plugin that is not installed paints",
    file: DERIVED,
    edits: [["paintsOf(el, installed)?.text", "paintsOf(el)?.text"]],
    test: TEST,
    name: NOT_INSTALLED,
    expects: answered("merge: text of the total", true),
  },
  "strip-repainted-static": {
    what: "stripRepainted strips every rule, so a merge input loses what a plugin that is not installed painted",
    file: DERIVED,
    edits: [["stripPaints(root, installed);", "stripPaints(root);"]],
    test: TEST,
    name: NOT_INSTALLED,
    expects: answered("merge: stripped from the total", true),
  },
  "repaints-attr-without-engine": {
    what: "repaintsAttr answers yes in a tab with no engine",
    file: DERIVED,
    edits: [["derivedActive() && ownsAttr(el, name, null, installed)", "ownsAttr(el, name, null, installed)"]],
    test: TEST,
    name: NO_ENGINE,
    expects: answered("merge: data-next on the output", true),
  },
  "repaints-text-without-engine": {
    what: "repaintsText answers yes in a tab with no engine",
    file: DERIVED,
    edits: [["derivedActive() && !!el && el.nodeType === 1 && ", "!!el && el.nodeType === 1 && "]],
    test: TEST,
    name: NO_ENGINE,
    expects: answered("merge: text of the output", true),
  },
  "strip-repainted-without-engine": {
    what: "stripRepainted strips painted values in a tab with no engine",
    file: DERIVED,
    edits: [["  if (derivedActive()) stripPaints(root, installed);", "  stripPaints(root, installed);"]],
    test: TEST,
    name: NO_ENGINE,
    expects: answered("merge: stripped from the output", true),
  },
  "hub-asks-merge-question": {
    what: "the mutation hub asks whether a value is painted again, so a plugin's output counts as an edit while the plugin is not installed",
    file: DERIVED,
    edits: [["      derived = ownsDerivedText(el);", "      derived = repaintsText(el);"]],
    test: TEST,
    name: NOT_INSTALLED,
    expects: answered("edit: a text change on the total", false),
  },
  "compare-asks-merge-question": {
    what: "the dirty check strips only what is painted again, so a plugin that installs after the baseline makes the page dirty",
    file: SNAPSHOT,
    edits: [["import { stripDerived, flushDerived } from '../lib/derived.js';", "import { stripRepainted as stripDerived, flushDerived } from '../lib/derived.js';"]],
    test: TEST,
    name: LATE,
    expects: /Expected: "[^\n]*data-sum=\\"0\\">0<\/li>/,
  },
  "signature-asks-merge-question": {
    what: "a paint signature counts a plugin's output only while it is installed, so a signature from before the install never matches one from after",
    file: DERIVED,
    edits: [[SIGNATURE_WALK_END, SIGNATURE_WALK_END.replace("});", "}, installed);")]],
    test: TEST,
    name: HEAL_RIGHT,
    expects: /\+\s+"<!DOCTYPE html>/,
  },
  "signature-without-plugins": {
    what: "a paint signature leaves every plugin's output out, so a stale file a plugin repainted never heals",
    file: DERIVED,
    edits: [[SIGNATURE_WALK_END, SIGNATURE_WALK_END.replace("});", "}, () => false);")]],
    test: TEST,
    name: HEAL_STALE,
    expects: /Expected: 1\s+Received: 0/,
  },
  "merge-strips-every-rule": {
    what: "live sync strips every painted value from a merge input, a plugin that is not installed included",
    file: LIVE,
    edits: [[LIVE_IMPORT, liveImportWith("stripDerived, derivedActive")], ["  stripRepainted(root);\n", "  if (derivedActive()) stripDerived(root);\n"]],
    test: TEST,
    name: NO_PLUGIN,
    expects: shows("text", "7"),
  },
  "merge-keeps-every-painted-text": {
    what: "live sync keeps this tab's text wherever any rule paints, so a tab without the plugin keeps its old total",
    file: LIVE,
    edits: [[LIVE_IMPORT, liveImportWith("ownsDerivedText, derivedActive")], ["repaintsText(el)", "(derivedActive() && ownsDerivedText(el))"]],
    test: TEST,
    name: NO_PLUGIN,
    expects: shows("text", "7"),
  },
  "merge-ignores-every-painted-attr": {
    what: "live sync ignores an attribute wherever any rule paints it, so a tab without the plugin keeps its old data-sum",
    file: LIVE,
    edits: [[LIVE_IMPORT, liveImportWith("isDerivedAttr, derivedActive")], ["repaintsAttr(merged || el, name)", "(derivedActive() && isDerivedAttr(merged || el, name))"]],
    test: TEST,
    name: NO_PLUGIN,
    expects: shows("sum", "7"),
  },
  "merge-never-repaints-plugin": {
    what: "a merge takes an installed plugin's output as content, so the total's text and data-sum, which both tabs changed, read as two conflicts",
    file: DERIVED,
    edits: [[INSTALLED, "const installed = () => false;"]],
    test: TEST,
    name: PLUGIN,
    expects: /Expected: 0\s+Received: 2/,
  },
  "merge-strips-without-engine": {
    what: "a merge into a tab with no engine strips painted values that nothing will paint again",
    file: DERIVED,
    edits: [["  if (derivedActive()) stripPaints(root, installed);", "  stripPaints(root, installed);"]],
    test: "tests/unit/derived-paints.test.js",
    name: "a page with no derive engine keeps the painted values a disk frame brings",
    expects: /Expected: "accepted"/,
  },
});

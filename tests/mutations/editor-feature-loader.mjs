// node tests/mutations/editor-feature-loader.mjs [wrapped-export] [shared-instance] [shared-pending] [shared-prepared] [late-install] [late-dispose] [feature-import]
// Each entry puts one bug into a scratch copy of the shared feature loader, or of the
// page file that re-exports it, and names the test that must then fail. With no
// argument every entry runs, one after another.
import { mutate } from "./harness.mjs";

const TEST = "tests/unit/editor-feature-loader.test.js";
const LOADER = "src/lib/editor-feature-loader.js";
const PAGE = "src/page/feature-loader.js";
const OPEN = "export function createFeatureLoader(";

// The bug each of these restores: one of the loader's three caches at module scope, so
// every loader on the page shares it.
const atModuleScope = (cache) => [
  [`  const ${cache} = new Map();\n`, ""],
  [OPEN, `const ${cache} = new Map();\n${OPEN}`],
];

mutate({
  "wrapped-export": {
    what: "the page file exports its own function around the shared loader instead of the shared loader",
    file: PAGE,
    edits: [[
      'export { createFeatureLoader } from "../lib/editor-feature-loader.js";',
      'import { createFeatureLoader as shared } from "../lib/editor-feature-loader.js";\nexport const createFeatureLoader = (options) => shared(options);',
    ]],
    test: TEST,
    name: "the page path exports the shared loader itself",
    expects: /Expected: \[Function createFeatureLoader\]/,
  },
  "shared-instance": {
    what: "the installed features are one module-scope Map, so a second loader is handed the first loader's feature",
    file: LOADER,
    edits: atModuleScope("installed"),
    test: TEST,
    name: "a loader never hands out a feature another loader installed",
    expects: /-\s+"second",\n\+\s+"first",/,
  },
  "shared-pending": {
    what: "the fetches in flight are one module-scope Map, so a second loader waits on the first loader's install",
    file: LOADER,
    edits: atModuleScope("pending"),
    test: TEST,
    name: "two loaders with the same feature on the wire each use their own fetch",
    expects: /Expected: "first"\nReceived: "second"/,
  },
  "shared-prepared": {
    what: "the prepared fetches are one module-scope Map, so a second loader consumes the first loader's preparation",
    file: LOADER,
    edits: atModuleScope("prepared"),
    test: TEST,
    name: "two loaders with the same feature on the wire each use their own fetch",
    expects: /\+\s+"table",/,
  },
  "late-install": {
    what: "a fetch that lands after dispose is installed anyway",
    file: LOADER,
    edits: [[".then((mod) => (disposed ? null : Promise.resolve(install(id, mod))))", ".then((mod) => Promise.resolve(install(id, mod)))"]],
    test: TEST,
    name: "a loader disposed before its fetch lands installs nothing, and refuses every later ask",
    expects: /- Array \[\]\n\+ Array \[\n\+\s+"table",/,
  },
  "late-dispose": {
    what: "a feature whose install resolves after dispose is kept and never disposed",
    file: LOADER,
    edits: [["          if (disposed) {\n            feature?.dispose?.();\n            return feature;\n          }\n", ""]],
    test: TEST,
    name: "a loader disposed while an install is resolving disposes the feature that install returns, once, and keeps none",
    expects: /Expected: 1\nReceived: 0/,
  },
  "feature-import": {
    what: "the shared loader imports the page's feature registry, and every feature with it",
    file: LOADER,
    edits: [[OPEN, `import "../page/features/registry.js";\n${OPEN}`]],
    test: TEST,
    name: "the shared loader's module graph holds no editor, feature or vendored library, and the page editor's graph holds them all",
    expects: /\+\s+"a feature module: \d+, the first is src\/page\/features\//,
  },
});

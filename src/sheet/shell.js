import { canAdopt, createRowWindow, EARLY, scopeOf } from "./row-window.js";

// What both halves of the sheet run: a row window on every grid table under a [sap]
// root, following its Grid once the engine has mounted. The page's own early rule is
// dropped once every table has its window.
export function startShell({ root = document, windowOptions = {} } = {}) {
  const windows = new Map();
  const custom = Boolean(windowOptions.sheet || windowOptions.adopt);
  if (custom || canAdopt(root.ownerDocument ?? root)) {
    for (const table of root.querySelectorAll("[sap] table[grid]")) {
      // A rule that would also select another table hides that table's rows too, so a
      // table its scope does not name alone gets no window: it shows every row, slower.
      const named = document.querySelectorAll(scopeOf(table));
      if (named.length !== 1 || named[0] !== table) continue;
      windows.set(table, createRowWindow(table, windowOptions));
    }
    dropEarly();
  }
  // Sap.grid exists once the grid plugin installed, which derive.js waits for before
  // the mount; clay.ready resolves after the mount. Not part of the plugin's `ready`:
  // the loader waits for every plugin's ready before it mounts.
  // The engine stops waiting for plugins after a few seconds, so on a slow connection the
  // mount can come before the grid: this joins the download still on its way.
  const followed = Promise.resolve(window.clay?.ready).then(async () => {
    if (windows.size === 0) return;
    if (typeof window.Sap?.grid !== "function") await window.Sap?.plugins?.load?.("grid");
    const gridOf = window.Sap?.grid;
    if (typeof gridOf !== "function") return;
    // The early rule is gone and the mount has painted (a stale sheet's text changes
    // as it opens), so every window measures what it shows again, once.
    for (const [table, win] of windows) {
      gridOf(table).on("change", win.follow);
      win.follow({ rescanned: true });
    }
  });
  followed.catch((error) => console.error("clayjs: the sheet could not follow its grid", error));
  return { windows, followed };
}

function dropEarly() {
  const early = window[EARLY];
  if (!early) return;
  delete window[EARLY];
  if ("adoptedStyleSheets" in document) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== early);
  }
}

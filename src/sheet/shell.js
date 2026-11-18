import { canAdopt, createRowWindow, EARLY, scopeOf } from "./row-window.js";

// What both halves of the sheet run: a row window on every grid table under a [sap]
// root, following its Grid once the engine has mounted. The page's own early rule is
// dropped once every table has its window.
export function startShell({ root = document, windowOptions = {} } = {}) {
  const windows = new Map();
  const unsubscribe = [];
  const custom = Boolean(windowOptions.sheet || windowOptions.adopt);
  const canWindow = custom || canAdopt(root.ownerDocument ?? root);

  // A window for every table that has none; a table that left the page loses its window. A
  // table that stayed keeps its window and the row heights it measured.
  function open() {
    if (!canWindow) return;
    const keep = new Set();
    for (const table of root.querySelectorAll("[sap] table[grid]")) {
      // A rule that would also select another table hides that table's rows too, so a
      // table its scope does not name alone gets no window: it shows every row, slower.
      const named = document.querySelectorAll(scopeOf(table));
      if (named.length !== 1 || named[0] !== table) continue;
      keep.add(table);
      if (!windows.has(table)) windows.set(table, createRowWindow(table, windowOptions));
    }
    for (const [table, win] of windows) {
      if (keep.has(table)) continue;
      win.dispose();
      windows.delete(table);
    }
  }

  // Every window follows its table's Grid, and measures what it shows again, once.
  function subscribe(gridOf) {
    for (const off of unsubscribe.splice(0)) off();
    for (const [table, win] of windows) {
      unsubscribe.push(gridOf(table).on("change", win.follow));
      win.follow({ rescanned: true });
    }
  }

  open();
  if (canWindow) dropEarly();
  // Sap.grid exists once the grid plugin installed; clay.ready resolves after the mount. The
  // engine stops waiting for plugins after a few seconds, so on a slow connection the mount can
  // come before the grid: this joins the download still on its way.
  const followed = Promise.resolve(window.clay?.ready).then(async () => {
    if (windows.size === 0) return;
    if (typeof window.Sap?.grid !== "function") await window.Sap?.plugins?.load?.("grid");
    if (typeof window.Sap?.grid === "function") subscribe(window.Sap.grid);
  });
  followed.catch((error) => console.error("clayjs: the sheet could not follow its grid", error));

  // The workbook was rebuilt (a merge took a peer's tabs, or the grid loaded late): every window
  // follows the tables and Grids the page holds now.
  function restart() {
    open();
    if (typeof window.Sap?.grid === "function") subscribe(window.Sap.grid);
  }

  return { windows, followed, restart };
}

function dropEarly() {
  const early = window[EARLY];
  if (!early) return;
  delete window[EARLY];
  if ("adoptedStyleSheets" in document) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== early);
  }
}

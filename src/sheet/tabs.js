import { canAdopt } from "./row-window.js";

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const VALID_KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
const MAX_COUNT = 9999999;

export const isKey = (key) => typeof key === "string" && VALID_KEY.test(key);

function midpoint(a, b) {
  if (b !== null) {
    let n = 0;
    while ((a[n] || "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

export function keyBetween(a = null, b = null) {
  const low = a && isKey(a) ? a : null;
  const high = b && isKey(b) && (!low || low < b) ? b : null;
  return midpoint(low ?? "", high);
}

export function keysBetween(a, b, n) {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  const mid = keyBetween(a, b);
  const half = Math.floor(n / 2);
  return [...keysBetween(a, mid, half), mid, ...keysBetween(mid, b, n - half - 1)];
}

export function nextSheetName(tabs) {
  const taken = new Set(tabs.map((t) => t.name.toLowerCase()));
  for (let n = 1; ; n++) {
    const candidate = `Sheet ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function nextCopyName(baseName, tabs) {
  const taken = new Set(tabs.map((t) => t.name.toLowerCase()));
  const first = `Copy of ${baseName}`;
  if (!taken.has(first.toLowerCase())) return first;
  for (let n = 2; ; n++) {
    const candidate = `Copy of ${baseName} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function mintTabId(tabs, newId) {
  const taken = new Set(tabs.map((t) => t.id));
  for (let tries = 0; tries < 100; tries++) {
    const id = typeof newId === "function" ? newId("s") : `s${Date.now().toString(36)}${tries}`;
    if (id && !taken.has(id)) return id;
  }
  return `s${Date.now().toString(36)}`;
}

const cleanText = (text) => String(text ?? "").replace(/\r\n?/g, "\n").replace(/\0/g, "");

function parseCount(raw, min) {
  if (raw === null || !/^[0-9]{1,7}$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return n >= min && n <= MAX_COUNT ? n : undefined;
}

function readDomCell(td) {
  const cell = { text: cleanText(td.textContent) };
  let bare = true;
  const set = (key, value) => {
    if (value === undefined || value === null || value === false) return;
    cell[key] = value;
    bare = false;
  };
  set("n", td.hasAttribute("n"));
  set("t", td.hasAttribute("t"));
  for (const key of ["f", "v", "fmt"]) {
    const val = td.getAttribute(key);
    set(key, val === null ? undefined : cleanText(val));
  }
  set("colspan", parseCount(td.getAttribute("colspan"), 2));
  set("rowspan", parseCount(td.getAttribute("rowspan"), 2));
  if (td.hasAttribute("hidden")) {
    set("hidden", true);
    cell.text = "";
  }
  const style = td.getAttribute("style");
  set("style", style === null ? undefined : cleanText(style));
  return bare && cell.text === "" ? null : cell;
}

function readDomRow(tr, frozen) {
  const row = {
    id: cleanText(tr.getAttribute("data-id") ?? ""),
    pos: cleanText(tr.getAttribute("data-pos") ?? ""),
  };
  if (frozen) row.frozen = true;
  if (tr.hasAttribute("hidden")) row.hidden = true;
  const style = tr.getAttribute("style");
  if (style !== null) row.style = cleanText(style);
  row.cells = [...tr.children]
    .filter((el) => el.localName === "td" || el.localName === "th")
    .map(readDomCell);
  return row;
}

function readDomCol(colEl) {
  const col = {
    id: cleanText(colEl.getAttribute("data-id") ?? ""),
    pos: cleanText(colEl.getAttribute("data-pos") ?? ""),
  };
  const fmt = colEl.getAttribute("fmt");
  if (fmt !== null) col.fmt = cleanText(fmt);
  if (colEl.hasAttribute("hidden")) col.hidden = true;
  const width = /width:\s*([0-9]{1,7})px/.exec(colEl.getAttribute("style") ?? "");
  if (width) col.width = Number(width[1]);
  return col;
}

export function emptyTableHtml(tabId, sapGrid, { colsCount = 26, rowsCount = 100 } = {}) {
  const taken = new Set();
  const mint = (prefix) => {
    for (let i = 0; i < 100; i++) {
      const id = sapGrid.newId(prefix);
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    return `${prefix}${taken.size + 1}`;
  };
  const cols = keysBetween(null, null, colsCount).map((pos) => ({ id: mint("c"), pos }));
  const rows = keysBetween(null, null, rowsCount).map((pos) => ({ id: mint("r"), pos, cells: [] }));
  return sapGrid.createSheetWriter().table(tabId, { cols, rows });
}

export function duplicateTableHtml(tabId, table, sapGrid) {
  const sheet = { cols: [], rows: [] };
  const freezeCols = parseCount(table.getAttribute("freeze-cols"), 1);
  if (freezeCols !== undefined) sheet.freezeCols = freezeCols;
  if (table.hasAttribute("stale")) sheet.stale = true;
  const frozen = [];
  const data = [];
  for (const part of table.children) {
    const name = part.localName;
    if (name === "colgroup") {
      for (const col of part.children) if (col.localName === "col") sheet.cols.push(readDomCol(col));
    } else if (name === "col") {
      sheet.cols.push(readDomCol(part));
    } else if (name === "thead" || name === "tbody" || name === "tfoot") {
      const into = name === "thead" ? frozen : data;
      for (const tr of part.children) if (tr.localName === "tr") into.push(readDomRow(tr, name === "thead"));
    } else if (name === "tr") {
      data.push(readDomRow(part, false));
    }
  }
  sheet.rows = [...frozen, ...data];
  return sapGrid.createSheetWriter().table(tabId, sheet);
}

const childOf = (el, test) => {
  for (let node = el?.firstElementChild ?? null; node !== null; node = node.nextElementSibling) {
    if (test(node)) return node;
  }
  return null;
};

const escapeAttr = (value) => String(value).replace(/["\\]/g, "\\$&");

export function readTabs(workbook) {
  const list = [];
  for (let node = workbook?.firstElementChild ?? null; node !== null; node = node.nextElementSibling) {
    if (node.localName !== "section" || !node.hasAttribute("item")) continue;
    const id = node.getAttribute("data-id") ?? "";
    const pos = node.getAttribute("data-pos") ?? "";
    const heading = childOf(node, (el) => el.localName === "h2" && el.getAttribute("bind") === "name");
    const table = childOf(node, (el) => el.localName === "table" && el.hasAttribute("grid"));
    list.push({ id, name: heading?.textContent ?? "", pos, section: node, table });
  }
  return list;
}

export function tabRuleText(id, scope = "[sheet-workbook]") {
  const hideOthers = id ? `${scope} > section[item]:not([data-id="${escapeAttr(id)}"]) { display: none }` : "";
  return `@media screen { ${hideOthers} ${scope} > section[item] > h2[bind="name"] { display: none } }`;
}

export function createTabs(workbook, { sheet: customSheet = null, adopt: customAdopt = null, drop: customDrop = null } = {}) {
  const doc = workbook.ownerDocument ?? document;
  const scope = "[sheet-workbook]";
  const adoptable = Boolean(customSheet || customAdopt || canAdopt(doc));
  const sheet = customSheet ?? (adoptable ? new doc.defaultView.CSSStyleSheet() : null);
  let fallbackStyle = null;
  let activeId = "";
  let disposed = false;

  const adopt = customAdopt ?? ((s) => {
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, s];
  });
  const drop = customDrop ?? ((s) => {
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((one) => one !== s);
  });

  if (sheet) {
    adopt(sheet);
  } else {
    fallbackStyle = doc.createElement("style");
    fallbackStyle.setAttribute("clay", "editor-ui");
    fallbackStyle.setAttribute("sap-ignore", "");
    (doc.head ?? doc.documentElement).append(fallbackStyle);
  }

  function applyRule(id) {
    if (disposed) return;
    activeId = id;
    const css = tabRuleText(id, scope);
    if (sheet) sheet.replaceSync(css);
    else if (fallbackStyle && fallbackStyle.textContent !== css) fallbackStyle.textContent = css;
  }

  const initial = readTabs(workbook)[0]?.id ?? "";
  applyRule(initial);

  return {
    get activeId() {
      return activeId;
    },
    get sheet() {
      return sheet;
    },
    list: () => readTabs(workbook),
    show(id) {
      if (id !== activeId) applyRule(id);
    },
    refresh() {
      const tabs = readTabs(workbook);
      if (tabs.some((tab) => tab.id === activeId)) return activeId;
      const next = tabs[0]?.id ?? "";
      applyRule(next);
      return next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (sheet) drop(sheet);
      fallbackStyle?.remove();
    },
  };
}

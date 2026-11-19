import { createGeometry, ROW_ESTIMATE } from "./geometry.js";
import { colName } from "./commit.js";
import { FONT_MONO, TOKENS } from "../ui/bevel.js";
import { resolveTheme } from "../ui/theme.js";
import { mountEditorUI } from "../ui/editor-ui.js";

const GUTTER_W = 42;
const HEADER_H = 24;

const REF_COLORS = [
  { border: TOKENS.brass, fill: TOKENS["brass-soft"] },
  { border: TOKENS.teal, fill: TOKENS["teal-soft"] },
  { border: "light-dark(#6E4076, #C388CE)", fill: "light-dark(#F1E8F3, #2B1E33)" },
  { border: "light-dark(#9A4E1C, #D8844F)", fill: "light-dark(#F6E6DA, #2E1F16)" },
];

const OVERLAY_CSS = `
.sheet-overlays {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  overflow: visible;
  z-index: 8;
  font-family: ${FONT_MONO};
  font-variant-numeric: tabular-nums;
  --sheet-sunk: ${TOKENS.sunk};
  --sheet-surface: ${TOKENS.surface};
  --sheet-muted: ${TOKENS.muted};
  --sheet-line-2: ${TOKENS["line-2"]};
  --sheet-sel: light-dark(#1D5B79, #5CA8CC);
  --sheet-sel-fill: light-dark(#E5F0F6, #182B3A);
  --sheet-sel-head: light-dark(#D8E8F1, #1E3548);
  --sheet-sel-line: light-dark(#ADCBE0, #2D4F6C);
  --sheet-brass: ${TOKENS.brass};
}
.sheet-overlays, .sheet-overlays * {
  box-sizing: border-box;
}
.sheet-corner, .sheet-col-hdr, .sheet-row-hdr {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--sheet-sunk);
  color: var(--sheet-muted);
  font-family: ${FONT_MONO};
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  user-select: none;
  cursor: pointer;
  border-right: 1px solid var(--sheet-line-2);
  border-bottom: 1px solid var(--sheet-line-2);
}
.sheet-col-hdr[data-active="true"], .sheet-row-hdr[data-active="true"] {
  background: var(--sheet-sel-head);
  color: var(--sheet-sel);
  font-weight: 600;
}
.sheet-row-hdr[data-active-next="true"] {
  border-bottom-color: var(--sheet-sel-line);
}
.sheet-sel-fill {
  position: absolute;
  pointer-events: none;
  background: color-mix(in srgb, var(--sheet-sel-fill) 42%, transparent);
  border: 2px solid var(--sheet-sel);
  z-index: 2;
}
.sheet-active-ring {
  position: absolute;
  pointer-events: none;
  border: 2px solid var(--sheet-sel);
  z-index: 4;
}
.sheet-active-ring[data-editing="true"] {
  border-color: var(--sheet-brass);
  box-shadow: 0 2px 8px color-mix(in srgb, ${TOKENS.ink} 14%, transparent);
}
.sheet-ref-box {
  position: absolute;
  pointer-events: none;
  border: 2px dashed var(--ref-border);
  background: color-mix(in srgb, var(--ref-fill) 32%, transparent);
  z-index: 3;
}
.sheet-editor-slot {
  position: absolute;
  z-index: 6;
  pointer-events: none;
}
.sheet-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
`;

function placeBox(el, origin, box) {
  el.style.left = `${box.left - origin.left}px`;
  el.style.top = `${box.top - origin.top}px`;
  el.style.width = `${box.width}px`;
  el.style.height = `${box.height}px`;
}

function tableMetrics(table, win) {
  const headRows = table.tHead?.rows.length ?? 0;
  const geom = win ? win.geometry : createGeometry(table);
  const tBox = table.getBoundingClientRect();
  const headHeight = table.tHead?.offsetHeight ?? headRows * ROW_ESTIMATE;

  function cellBox(r, c) {
    if (r >= headRows && win) return win.cellBox(r - headRows, c);
    if (r < headRows) {
      const tr = table.tHead.rows[r];
      const trBox = tr.getBoundingClientRect();
      const top = trBox.height > 0 ? trBox.top : tBox.top + r * ROW_ESTIMATE;
      const height = trBox.height > 0 ? trBox.height : (tr.hidden ? 0 : ROW_ESTIMATE);
      return { left: tBox.left + geom.colLeft(c), top, width: geom.colWidth(c), height };
    }
    const br = r - headRows;
    return {
      left: tBox.left + geom.colLeft(c),
      top: tBox.top + headHeight + geom.rowTop(br),
      width: geom.colWidth(c),
      height: geom.rowHeight(br),
    };
  }

  function spanBox(top, left, bottom, right) {
    const tl = cellBox(top, left);
    const br = cellBox(bottom, right);
    return {
      left: tl.left,
      top: tl.top,
      width: Math.max(0, br.left + br.width - tl.left),
      height: Math.max(0, br.top + br.height - tl.top),
    };
  }

  function visibleRows(totalRows) {
    const list = [];
    for (let r = 0; r < Math.min(headRows, totalRows); r++) list.push(r);
    if (win?.shown && win.shown.last >= win.shown.first) {
      for (let g = win.shown.first - 1; g <= win.shown.last - 1; g++) {
        const [start, end] = geom.groupRows(g);
        for (let i = start; i < end && headRows + i < totalRows; i++) list.push(headRows + i);
      }
      return list;
    }
    for (let r = headRows; r < totalRows; r++) list.push(r);
    return list;
  }

  function cellAt(x, y) {
    if (headRows > 0) {
      if (x >= tBox.left && x < tBox.left + geom.width && y >= tBox.top && y < tBox.top + headHeight) {
        const c = geom.colAt(x - tBox.left);
        if (c === -1) return null;
        for (let r = 0; r < headRows; r++) {
          const b = cellBox(r, c);
          if (y >= b.top && y < b.top + b.height) return { r, c };
        }
      }
    }
    if (win) {
      const hit = win.cellAt(x, y);
      return hit ? { r: hit.r + headRows, c: hit.c } : null;
    }
    const bodyTop = tBox.top + headHeight;
    if (x < tBox.left || x >= tBox.left + geom.width || y < bodyTop || y >= bodyTop + geom.total()) return null;
    const br = geom.rowAt(y - bodyTop);
    const c = geom.colAt(x - tBox.left);
    return br === -1 || c === -1 ? null : { r: br + headRows, c };
  }

  return { cellBox, spanBox, visibleRows, cellAt, tableBox: tBox, width: geom.width };
}

export function createOverlays(workbook, { onSelectCol, onSelectRow, onSelectAll } = {}) {
  const doc = workbook.ownerDocument ?? document;
  const theme = resolveTheme();
  const root = doc.createElement("div");
  root.className = "sheet-overlays";
  root.style.colorScheme = theme.scheme;
  if (theme.tokens?.accent) root.style.setProperty("--sheet-sel", theme.tokens.accent);
  if (theme.tokens?.surface) root.style.setProperty("--sheet-surface", theme.tokens.surface);
  if (theme.tokens?.background) root.style.setProperty("--sheet-sunk", theme.tokens.background);
  if (theme.tokens?.border) root.style.setProperty("--sheet-line-2", theme.tokens.border);
  if (theme.tokens?.mutedText) root.style.setProperty("--sheet-muted", theme.tokens.mutedText);

  const corner = doc.createElement("div");
  corner.className = "sheet-corner";
  corner.setAttribute("role", "presentation");
  corner.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onSelectAll?.();
  });

  const colsLayer = doc.createElement("div");
  colsLayer.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const hdr = e.target.closest?.("[data-col]");
    if (!hdr) return;
    e.preventDefault();
    onSelectCol?.(Number(hdr.getAttribute("data-col")), e.shiftKey);
  });

  const rowsLayer = doc.createElement("div");
  rowsLayer.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const hdr = e.target.closest?.("[data-row]");
    if (!hdr) return;
    e.preventDefault();
    onSelectRow?.(Number(hdr.getAttribute("data-row")), e.shiftKey);
  });

  const refsLayer = doc.createElement("div");
  const selFill = doc.createElement("div");
  selFill.className = "sheet-sel-fill";
  selFill.hidden = true;

  const activeRing = doc.createElement("div");
  activeRing.className = "sheet-active-ring";
  activeRing.hidden = true;

  const editorSlot = doc.createElement("div");
  editorSlot.className = "sheet-editor-slot";

  const live = doc.createElement("div");
  live.className = "sheet-sr-only";
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");

  root.append(corner, colsLayer, rowsLayer, refsLayer, selFill, activeRing, editorSlot, live);

  const parent = workbook.parentElement ?? doc.body;
  const ui = mountEditorUI({
    name: "sheet-overlays",
    content: root,
    css: [OVERLAY_CSS],
    parent,
    before: workbook.nextSibling,
    attributes: { "sap-ignore": "" },
  });

  function render({ table, win, view, box, editing = false, refs = [], shownTab = "" }) {
    if (!table || !view || view.rows.length === 0 || view.cols.length === 0) {
      colsLayer.textContent = "";
      rowsLayer.textContent = "";
      refsLayer.textContent = "";
      selFill.hidden = true;
      activeRing.hidden = true;
      corner.hidden = true;
      return;
    }

    const origin = root.getBoundingClientRect();
    const metrics = tableMetrics(table, win);
    const firstCell = metrics.cellBox(0, 0);

    corner.hidden = false;
    placeBox(corner, origin, {
      left: firstCell.left - GUTTER_W,
      top: firstCell.top - HEADER_H,
      width: GUTTER_W,
      height: HEADER_H,
    });

    while (colsLayer.children.length > view.cols.length) colsLayer.lastElementChild.remove();
    for (let c = 0; c < view.cols.length; c++) {
      let el = colsLayer.children[c];
      if (!el) {
        el = doc.createElement("div");
        el.className = "sheet-col-hdr";
        colsLayer.append(el);
      }
      const cb = metrics.cellBox(0, c);
      el.hidden = cb.width === 0;
      el.setAttribute("data-col", String(c));
      el.setAttribute("data-active", box && c >= box.left && c <= box.right ? "true" : "false");
      const label = colName(c);
      if (el.textContent !== label) el.textContent = label;
      placeBox(el, origin, { left: cb.left, top: firstCell.top - HEADER_H, width: cb.width, height: HEADER_H });
    }

    const visRows = metrics.visibleRows(view.rows.length);
    while (rowsLayer.children.length > visRows.length) rowsLayer.lastElementChild.remove();
    visRows.forEach((r, idx) => {
      let el = rowsLayer.children[idx];
      if (!el) {
        el = doc.createElement("div");
        el.className = "sheet-row-hdr";
        rowsLayer.append(el);
      }
      const rb = metrics.cellBox(r, 0);
      el.hidden = rb.height === 0;
      el.setAttribute("data-row", String(r));
      const active = Boolean(box && r >= box.top && r <= box.bottom);
      const nextActive = Boolean(active && box && r < box.bottom);
      el.setAttribute("data-active", active ? "true" : "false");
      el.setAttribute("data-active-next", nextActive ? "true" : "false");
      const label = String(r + 1);
      if (el.textContent !== label) el.textContent = label;
      placeBox(el, origin, { left: firstCell.left - GUTTER_W, top: rb.top, width: GUTTER_W, height: rb.height });
    });

    const visibleRefs = refs.filter((ref) => ref.tab === shownTab);
    while (refsLayer.children.length > visibleRefs.length) refsLayer.lastElementChild.remove();
    visibleRefs.forEach((ref, idx) => {
      let el = refsLayer.children[idx];
      if (!el) {
        el = doc.createElement("div");
        el.className = "sheet-ref-box";
        refsLayer.append(el);
      }
      const r0 = Math.max(0, Math.min(view.rows.length - 1, ref.area.r0 ?? 0));
      const r1 = Math.max(0, Math.min(view.rows.length - 1, ref.area.r1 ?? view.rows.length - 1));
      const c0 = Math.max(0, Math.min(view.cols.length - 1, ref.area.c0 ?? 0));
      const c1 = Math.max(0, Math.min(view.cols.length - 1, ref.area.c1 ?? view.cols.length - 1));
      const palette = REF_COLORS[ref.colorIndex % REF_COLORS.length];
      el.style.setProperty("--ref-border", palette.border);
      el.style.setProperty("--ref-fill", palette.fill);
      placeBox(el, origin, metrics.spanBox(r0, c0, r1, c1));
    });

    if (!box) {
      selFill.hidden = true;
      activeRing.hidden = true;
      placeBox(editorSlot, origin, { left: origin.left, top: origin.top, width: 1, height: 1 });
      editorSlot.style.opacity = "0";
      editorSlot.style.pointerEvents = "none";
      return;
    }
    editorSlot.style.opacity = "";
    editorSlot.style.pointerEvents = "";

    const activeBox = metrics.spanBox(
      box.active.r,
      box.active.c,
      box.active.r + box.active.rows - 1,
      box.active.c + box.active.cols - 1,
    );
    const wholeBox = metrics.spanBox(box.top, box.left, box.bottom, box.right);
    const multi =
      box.top !== box.active.r ||
      box.left !== box.active.c ||
      box.bottom !== box.active.r + box.active.rows - 1 ||
      box.right !== box.active.c + box.active.cols - 1;

    selFill.hidden = !multi;
    if (multi) placeBox(selFill, origin, wholeBox);

    activeRing.hidden = false;
    activeRing.setAttribute("data-editing", editing ? "true" : "false");
    placeBox(activeRing, origin, activeBox);
    placeBox(editorSlot, origin, activeBox);
  }

  function announce(text) {
    if (live.textContent !== text) live.textContent = text;
  }

  function cellAtPoint(table, win, x, y) {
    if (!table) return null;
    return tableMetrics(table, win).cellAt(x, y);
  }

  function cellBox(table, win, r, c) {
    if (!table) return null;
    return tableMetrics(table, win).cellBox(r, c);
  }

  return {
    host: ui.host,
    shadow: ui.shadow,
    root,
    editorSlot,
    live,
    render,
    announce,
    cellAtPoint,
    cellBox,
    dispose: () => ui.remove(),
  };
}

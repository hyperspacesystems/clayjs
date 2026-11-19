import { a1 } from "./commit.js";
import { SWATCHES } from "./menu.js";
import { commandArea, ownerOf, selectionArea, selectionBox } from "./selection.js";

export const BORDER_LINE = "1px solid #5F6368";

export const NUMBER_FORMATS = [
  { id: "auto", label: "Automatic", fmt: null, group: 0 },
  { id: "text", label: "Plain text", fmt: "@", group: 0 },
  { id: "number", label: "Number", fmt: "#,##0.00", group: 1 },
  { id: "thousands", label: "Thousands", fmt: "#,##0", group: 1 },
  { id: "percent", label: "Percent", fmt: "0.00%", group: 1 },
  { id: "currency", label: "Currency", fmt: "$#,##0.00", group: 1 },
  { id: "date", label: "Date", fmt: "m/d/yyyy", group: 2 },
  { id: "long-date", label: "Long date", fmt: "mmmm d, yyyy", group: 2 },
  { id: "time", label: "Time", fmt: "h:mm AM/PM", group: 2 },
  { id: "datetime", label: "Date and time", fmt: "m/d/yyyy h:mm", group: 2 },
];

export const BORDER_PRESETS = [
  { id: "all", label: "All", preset: "all" },
  { id: "outer", label: "Outer", preset: "outer" },
  { id: "inner", label: "Inner", preset: "inner" },
  { id: "top", label: "Top", preset: "top" },
  { id: "bottom", label: "Bottom", preset: "bottom" },
  { id: "left", label: "Left", preset: "left" },
  { id: "right", label: "Right", preset: "right" },
  { id: "none", label: "None", preset: "none" },
];

export const ALIGN_OPTIONS = [
  { id: "left", label: "Left", align: "left" },
  { id: "center", label: "Center", align: "center" },
  { id: "right", label: "Right", align: "right" },
];

export const CLEAR_STYLE = {
  "font-weight": null,
  "font-style": null,
  "text-decoration": null,
  color: null,
  background: null,
  "background-color": null,
  "text-align": null,
  "white-space": null,
};

export function formatLabelOf(fmt) {
  const norm = fmt === "" || fmt === undefined ? null : fmt;
  const found = NUMBER_FORMATS.find((entry) => entry.fmt === norm);
  return found ? found.label : "Custom";
}

export function numberFormatMenuItems({ activeValue, activeFmt, formatValue, onPick }) {
  const norm = activeFmt === "" || activeFmt === undefined ? null : activeFmt;
  const out = [];
  let prevGroup = 0;
  for (const entry of NUMBER_FORMATS) {
    if (entry.group !== prevGroup) {
      out.push({ type: "separator" });
      prevGroup = entry.group;
    }
    const detail = activeValue === null || activeValue === undefined || typeof formatValue !== "function"
      ? ""
      : (formatValue(activeValue, entry.fmt) ?? "");
    out.push({
      id: entry.id,
      label: entry.label,
      detail,
      checked: norm === entry.fmt,
      onSelect: () => onPick(entry.fmt),
    });
  }
  return out;
}

export function colorMenuItems({ current, onPick }) {
  return [
    { type: "swatches", colors: SWATCHES, current, onSelect: (hex) => onPick(hex) },
    { type: "separator" },
    { id: "reset", label: "Reset", onSelect: () => onPick(null) },
  ];
}

export function borderMenuItems({ onPick }) {
  return BORDER_PRESETS.map((entry, idx) =>
    idx === BORDER_PRESETS.length - 1
      ? [{ type: "separator" }, { id: entry.id, label: entry.label, onSelect: () => onPick(entry.preset) }]
      : [{ id: entry.id, label: entry.label, onSelect: () => onPick(entry.preset) }],
  ).flat();
}

export function alignMenuItems({ current, onPick }) {
  return ALIGN_OPTIONS.map((entry) => ({
    id: entry.id,
    label: entry.label,
    checked: current === entry.align,
    onSelect: () => onPick(entry.align),
  }));
}

export function parseStyleMap(css) {
  const map = Object.create(null);
  if (typeof css !== "string" || !css) return map;
  for (const part of css.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const val = part.slice(colon + 1).trim();
    if (key && val) map[key] = val;
  }
  return map;
}

export function cellStyleState(cell) {
  const style = parseStyleMap(cell?.style);
  const fw = (style["font-weight"] ?? "").toLowerCase();
  const fs = (style["font-style"] ?? "").toLowerCase();
  const td = (style["text-decoration"] ?? "").toLowerCase();
  const ws = (style["white-space"] ?? "").toLowerCase();
  return {
    bold: fw === "bold" || fw === "bolder" || (/^\d+$/.test(fw) && Number(fw) >= 700),
    italic: fs === "italic" || fs === "oblique",
    underline: /\bunderline\b/.test(td),
    strikethrough: /\bline-through\b/.test(td),
    wrap: ws === "pre-wrap",
    align: style["text-align"]?.toLowerCase() ?? null,
    color: style.color?.toLowerCase() ?? null,
    fillColor: (style["background-color"] ?? style.background)?.toLowerCase() ?? null,
    effectiveFmt: cell?.effectiveFmt ?? null,
    formatLabel: formatLabelOf(cell?.effectiveFmt ?? null),
  };
}

function decorationValue(underline, strikethrough) {
  if (underline && strikethrough) return "underline line-through";
  if (underline) return "underline";
  if (strikethrough) return "line-through";
  return null;
}

// Coalesces (r, c) coordinates carrying the same key into maximal A1 rectangles.
function coalesceRectangles(points) {
  const byRow = new Map();
  for (const { r, c } of points) {
    let list = byRow.get(r);
    if (!list) byRow.set(r, (list = []));
    list.push(c);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  const open = new Map();
  const rects = [];
  let prevRow = -2;
  for (const r of rows) {
    if (r !== prevRow + 1) {
      for (const rect of open.values()) rects.push(rect);
      open.clear();
    }
    prevRow = r;
    const cols = byRow.get(r).sort((a, b) => a - b);
    const runs = [];
    for (const c of cols) {
      const last = runs[runs.length - 1];
      if (last && last.c1 + 1 === c) last.c1 = c;
      else runs.push({ c0: c, c1: c });
    }
    const nextOpen = new Map();
    for (const run of runs) {
      const key = `${run.c0},${run.c1}`;
      const existing = open.get(key);
      if (existing) {
        existing.r1 = r;
        nextOpen.set(key, existing);
        open.delete(key);
      } else {
        nextOpen.set(key, { r0: r, c0: run.c0, r1: r, c1: run.c1 });
      }
    }
    for (const rect of open.values()) rects.push(rect);
    open.clear();
    for (const [k, v] of nextOpen) open.set(k, v);
  }
  for (const rect of open.values()) rects.push(rect);
  return rects.map(({ r0, c0, r1, c1 }) =>
    r0 === r1 && c0 === c1 ? a1(r0, c0) : `${a1(r0, c0)}:${a1(r1, c1)}`,
  );
}

export function applyStyleToggle(grid, view, sel, history, kind) {
  const box = selectionBox(view, sel);
  if (!box) return;
  const active = cellStyleState(grid.cell(a1(box.active.r, box.active.c)));
  const area = commandArea(view, sel);

  if (kind === "bold") {
    grid.format(area, { style: { "font-weight": active.bold ? null : "bold" } });
    return;
  }
  if (kind === "italic") {
    grid.format(area, { style: { "font-style": active.italic ? null : "italic" } });
    return;
  }
  if (kind === "wrap") {
    grid.format(area, { style: { "white-space": active.wrap ? null : "pre-wrap" } });
    return;
  }
  if (kind !== "underline" && kind !== "strikethrough") return;

  const wantVal = kind === "underline" ? !active.underline : !active.strikethrough;
  const buckets = new Map();
  for (let r = box.top; r <= box.bottom; r++) {
    for (let c = box.left; c <= box.right; c++) {
      const cell = grid.cell(a1(r, c));
      if (cell?.covered) continue;
      const st = cellStyleState(cell);
      const next = kind === "underline"
        ? decorationValue(wantVal, st.strikethrough)
        : decorationValue(st.underline, wantVal);
      const key = next ?? "__null__";
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = { value: next, points: [] }));
      list.points.push({ r, c });
    }
  }
  if (buckets.size === 0) return;
  if (buckets.size === 1) {
    const [{ value }] = buckets.values();
    grid.format(area, { style: { "text-decoration": value } });
    return;
  }
  history.group(sel.tab, () => {
    for (const { value, points } of buckets.values()) {
      for (const rectArea of coalesceRectangles(points)) {
        grid.format(rectArea, { style: { "text-decoration": value } });
      }
    }
  });
}

export function applyAlign(grid, view, sel, align) {
  grid.format(commandArea(view, sel), { style: { "text-align": align } });
}

export function applyTextColor(grid, view, sel, hexOrNull) {
  grid.format(commandArea(view, sel), { style: { color: hexOrNull } });
}

export function applyFillColor(grid, view, sel, hexOrNull) {
  grid.format(commandArea(view, sel), { style: { "background-color": hexOrNull } });
}

export function applyNumberFormat(grid, view, sel, fmt) {
  grid.format(commandArea(view, sel), { fmt });
}

export function applyBorder(grid, view, sel, preset) {
  const border = preset === "none" ? { preset: "none" } : { preset, line: BORDER_LINE };
  grid.format(commandArea(view, sel), { border });
}

export function applyClearFormatting(grid, view, sel, history) {
  const area = commandArea(view, sel);
  history.group(sel.tab, () => {
    grid.format(area, { fmt: null, style: CLEAR_STYLE, border: { preset: "none" } });
  });
}

export function applyDecimals(grid, view, sel, history, delta, adjustDecimals) {
  if (typeof adjustDecimals !== "function") return;
  const box = selectionBox(view, sel);
  if (!box) return;

  const buckets = new Map();
  let totalUncovered = 0;
  for (let r = box.top; r <= box.bottom; r++) {
    for (let c = box.left; c <= box.right; c++) {
      const cell = grid.cell(a1(r, c));
      if (!cell || cell.covered) continue;
      totalUncovered += 1;
      const cur = cell.effectiveFmt ?? null;
      const next = adjustDecimals(cur, delta, cell.value) ?? null;
      if (next === cur) continue;
      let list = buckets.get(next);
      if (!list) buckets.set(next, (list = []));
      list.push({ r, c });
    }
  }
  if (buckets.size === 0) return;

  if (buckets.size === 1) {
    const [[nextFmt, points]] = buckets.entries();
    const colHasFmt = grid.cell(a1(box.top, box.left))?.effectiveFmt !== null;
    if (points.length === totalUncovered && (sel?.whole !== "cols" || colHasFmt)) {
      grid.format(commandArea(view, sel), { fmt: nextFmt });
      return;
    }
  }

  history.group(sel.tab, () => {
    for (const [nextFmt, points] of buckets) {
      for (const rectArea of coalesceRectangles(points)) {
        grid.format(rectArea, { fmt: nextFmt });
      }
    }
  });
}

export function inspectMerge(grid, view, sel, { scan = true } = {}) {
  const box = selectionBox(view, sel);
  if (!box || !grid) return { canAct: false, isSingleMerge: false, area: "A1", box: null, filled: [] };
  const cellCount = (box.bottom - box.top + 1) * (box.right - box.left + 1);
  if (cellCount < 2) return { canAct: false, isSingleMerge: false, area: selectionArea(view, sel), box, filled: [] };

  const tl = ownerOf(view, box.top, box.left);
  const isSingleMerge =
    tl.r === box.top &&
    tl.c === box.left &&
    tl.rows === box.bottom - box.top + 1 &&
    tl.cols === box.right - box.left + 1;
  const area = selectionArea(view, sel);
  if (isSingleMerge) return { canAct: true, isSingleMerge: true, area, box, filled: [] };
  if (!scan) return { canAct: true, isSingleMerge: false, area, box, filled: [] };

  const filled = [];
  for (let r = box.top; r <= box.bottom; r++) {
    for (let c = box.left; c <= box.right; c++) {
      const ref = a1(r, c);
      const cell = grid.cell(ref);
      if (!cell || cell.covered) continue;
      if (cell.content !== null && cell.content !== "") {
        filled.push({ r, c, ref, text: cell.text, content: cell.content, fmt: cell.effectiveFmt ?? null });
      }
    }
  }
  return { canAct: true, isSingleMerge: false, area, box, filled };
}

export function mergeKeepingChoice(grid, box, area, chosen, history, tab) {
  history.group(tab, () => {
    grid.merge(area);
    if (chosen.r !== box.top || chosen.c !== box.left) {
      grid.setRange(a1(box.top, box.left), [[{ content: chosen.content, fmt: chosen.fmt ?? null }]], { detect: false });
    }
  });
}

export function runMergeCommand({ grid, view, sel, history, runWrite, promptKeep }) {
  const state = inspectMerge(grid, view, sel);
  if (!state.canAct) return false;
  if (state.isSingleMerge) {
    return runWrite(() => grid.unmerge(a1(state.box.top, state.box.left)));
  }
  if (state.filled.length === 0) return runWrite(() => grid.merge(state.area));
  if (state.filled.length === 1) {
    const [only] = state.filled;
    return runWrite(() => mergeKeepingChoice(grid, state.box, state.area, only, history, sel.tab));
  }
  promptKeep(state.filled, (chosen) => {
    runWrite(() => mergeKeepingChoice(grid, state.box, state.area, chosen, history, sel.tab));
  });
  return true;
}

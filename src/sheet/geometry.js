// Where things are in a sheet table: column offsets from the <col> widths, and row
// offsets from a prefix-sum index of row heights. A row's height is an estimate until
// the row has been laid out once; the row window measures the groups it shows and
// records each row's height by its id, so a rebuilt geometry keeps what was measured.
// Rows are the data rows, the <tr> of every <tbody> in order; frozen <thead> rows are
// never windowed and are not in the index.

export const ROW_ESTIMATE = 26;
export const COL_DEFAULT = 100;

// Values by index in a Fenwick tree: one change and one prefix sum each cost log n.
function fenwick(values) {
  const n = values.length;
  const tree = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    tree[i] += values[i - 1];
    const up = i + (i & -i);
    if (up <= n) tree[up] += tree[i];
  }
  let top = 1;
  while (top * 2 <= n) top *= 2;
  return {
    add(i, delta) {
      for (let k = i + 1; k <= n; k += k & -k) tree[k] += delta;
    },
    // The sum of values [0, i).
    sum(i) {
      let total = 0;
      for (let k = i; k > 0; k -= k & -k) total += tree[k];
      return total;
    },
    // How many leading values fit in y: the index of the value that holds y.
    find(y) {
      let at = 0;
      let left = y;
      for (let step = top; step > 0; step >>= 1) {
        const next = at + step;
        if (next <= n && tree[next] <= left) {
          at = next;
          left -= tree[next];
        }
      }
      return at;
    },
  };
}

export function tableParts(table) {
  const groups = [...table.tBodies];
  const rows = [];
  const groupStart = [];
  for (const group of groups) {
    groupStart.push(rows.length);
    rows.push(...group.rows);
  }
  const cols = [...table.querySelectorAll(":scope > colgroup > col")];
  return { groups, rows, groupStart, cols };
}

const widthOf = (col) => {
  if (col.hidden) return 0;
  const width = parseFloat(col.style.width);
  return Number.isFinite(width) ? width : COL_DEFAULT;
};

export function createGeometry(table, { measured = new Map() } = {}) {
  const { groups, rows, groupStart, cols } = tableParts(table);
  const ids = rows.map((tr) => tr.getAttribute("data-id"));
  const indexOf = new Map(ids.map((id, i) => [id, i]));
  const heights = rows.map((tr, i) => (rowOutOfSight(tr) ? 0 : measured.get(ids[i]) ?? ROW_ESTIMATE));
  const index = fenwick(heights);
  const groupOf = new Int32Array(rows.length);
  const groupHeights = groupStart.map((start, g) => {
    const end = groupStart[g + 1] ?? rows.length;
    groupOf.fill(g, start, end);
    return index.sum(end) - index.sum(start);
  });
  const widths = cols.map(widthOf);
  const lefts = [];
  let width = 0;
  for (const w of widths) {
    lefts.push(width);
    width += w;
  }

  return {
    rowCount: rows.length,
    groupCount: groups.length,
    width,
    row: (i) => rows[i],
    group: (g) => groups[g],
    groupRows: (g) => [groupStart[g], groupStart[g + 1] ?? rows.length],
    indexOf: (id) => indexOf.get(id) ?? -1,
    rowTop: (i) => index.sum(i),
    rowHeight: (i) => heights[i],
    // The row under y (body coordinates); the last row for y past the end, -1 with no rows.
    rowAt: (y) => (rows.length === 0 ? -1 : Math.min(index.find(Math.max(0, y)), rows.length - 1)),
    total: () => index.sum(rows.length),
    groupOfRow: (i) => groupOf[i],
    groupTop: (g) => index.sum(groupStart[g]),
    groupHeights: () => groupHeights,
    colLeft: (c) => lefts[c],
    colWidth: (c) => widths[c],
    // The column under x; the last column for x past the end, -1 with no columns.
    colAt(x) {
      if (widths.length === 0) return -1;
      let lo = 0;
      let hi = widths.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lefts[mid] <= x) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    // Records a laid out row's height and returns the change, so a caller keeping a row
    // on screen can move the scroll position by it.
    setRowHeight(i, height) {
      const delta = height - heights[i];
      // A row with no id yet (sapjs repairs it) is not kept: such rows would share one entry.
      if (ids[i]) measured.set(ids[i], height);
      if (delta === 0) return 0;
      heights[i] = height;
      index.add(i, delta);
      groupHeights[groupOf[i]] += delta;
      return delta;
    },
  };
}

// Rows this viewer filtered out, per table: a view of the sheet, never saved and never shared.
const filtered = new WeakMap();
const NONE = new Set();

export const filteredRows = (table) => (table && filtered.get(table)) || NONE;

export function setFilteredRows(table, ids) {
  if (!table) return;
  if (ids && ids.size > 0) filtered.set(table, new Set(ids));
  else filtered.delete(table);
}

// A row is out of sight when the file hides it or this viewer filtered it out.
export function rowOutOfSight(tr) {
  if (!tr) return false;
  if (tr.hidden) return true;
  const table = tr.closest?.("table");
  return Boolean(table && filtered.get(table)?.has(tr.getAttribute("data-id")));
}

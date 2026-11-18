// Samples for the codec laws (checkCodec in src/live-room/codec.js): a small workbook and
// actions on it, including rows that are missing, rows that already exist, empty values and
// text that needs escaping. A document holds no empty cell, because the reducer never keeps one.
const ROWS = ["r1", "r2", "r3", "r4", "r5", 'r<6>"'];
const COLS = ["c1", "c2", "c&3"];
const VALUES = ["", "x", "y", "café 🐈", '</td><td data-col="c2">&amp;', "</script>"];

export function sample(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const filled = VALUES.filter((value) => value !== "");
  const cells = (count) => Object.fromEntries(Array.from({ length: count }, () => [pick(COLS), pick(filled)]));
  const rows = {};
  for (const row of ROWS) if (random() < 0.6) rows[row] = { pos: String(Math.floor(random() * 9)), cells: cells(Math.floor(random() * 4)) };
  const action = () => {
    const kind = pick(["set", "set", "paste", "paste", "ins", "del"]);
    if (kind === "set") return { t: "set", row: pick(ROWS), col: pick(COLS), value: pick(VALUES) };
    if (kind === "paste") return { t: "paste", cells: Array.from({ length: Math.floor(random() * 11) }, () => [pick(ROWS), pick(COLS), pick(VALUES)]) };
    if (kind === "ins") return { t: "ins", row: pick(ROWS), pos: String(Math.floor(random() * 9)), cells: cells(Math.floor(random() * 3)) };
    return { t: "del", row: pick(ROWS) };
  };
  return { doc: { rows }, record: { v: 2, doc: "doc0123456789abc", gen: "1.00000001", commit: "c<1" }, actions: Array.from({ length: 8 }, action) };
}

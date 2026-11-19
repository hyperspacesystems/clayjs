/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterAll, beforeAll, expect, jest, test } from "@jest/globals";
import seedWindowHelpers from "../../helpers/seed-window.cjs";
import { shiftFormula } from "../../../src/sheet/refs.js";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

let tokenize;

beforeAll(async () => {
  jest.resetModules();
  delete window.Sap;
  delete window.sapPlugins;
  window.clay = { ready: new Promise(() => {}) };
  document.body.innerHTML =
    '<main sap plugins="grid"><div items="sheets" sheet-workbook><section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"></colgroup><tbody><tr data-id="r1" data-pos="V"><td n v="1">1</td></tr></tbody></table></section></div></main>';
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const books = ownWorkbooks({});
  await books.ready;
  Sap.mount();
  await turn();
  tokenize = window.Sap.grid.tokenize;
});

afterAll(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
});

const COL_LIMIT = 18278;
const colNumber = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
function colLetters(n) {
  let out = "";
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(65 + ((k - 1) % 26)) + out;
  return out;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHIFT_COLS = ["C", "D", "E", "AA"];
const shiftCell = (letters, absCol, row, absRow, dr, dc) => {
  const col = colNumber(letters) + (absCol ? 0 : dc);
  const r = row + (absRow ? 0 : dr);
  if (col < 1 || col > COL_LIMIT || r < 1) return "#REF!";
  return `${absCol ? "$" : ""}${colLetters(col)}${absRow ? "$" : ""}${r}`;
};

function cellAtom(rand) {
  const absCol = rand() < 0.25;
  const absRow = rand() < 0.25;
  const col = SHIFT_COLS[Math.floor(rand() * SHIFT_COLS.length)];
  const row = 3 + Math.floor(rand() * 6);
  return {
    src: `${absCol ? "$" : ""}${col}${absRow ? "$" : ""}${row}`,
    move: (dr, dc) => shiftCell(col, absCol, row, absRow, dr, dc),
  };
}

const PREFIXES = ["", "Data!", "'Q1 plan'!"];

const prefixOf = (rand) => PREFIXES[rand() < 0.35 ? (rand() < 0.5 ? 1 : 2) : 0];

const shiftCol = (letters, dc) => colLetters(colNumber(letters) + dc);

function rangeAtom(rand) {
  const pref = prefixOf(rand);
  const roll = rand();
  const col = () => SHIFT_COLS[Math.floor(rand() * SHIFT_COLS.length)];
  if (roll < 0.2) {
    const a = cellAtom(rand);
    const end = col();
    return { src: `${pref}${a.src}:${end}`, move: (dr, dc) => `${pref}${a.move(dr, dc)}:${shiftCol(end, dc)}` };
  }
  if (roll < 0.4) {
    const first = col();
    const last = col();
    return { src: `${pref}${first}:${last}`, move: (dr, dc) => `${pref}${shiftCol(first, dc)}:${shiftCol(last, dc)}` };
  }
  if (roll < 0.55) {
    const first = 3 + Math.floor(rand() * 5);
    const last = first + 1 + Math.floor(rand() * 4);
    return { src: `${pref}${first}:${last}`, move: (dr, dc) => `${pref}${first + dr}:${last + dr}` };
  }
  const a = cellAtom(rand);
  let b = cellAtom(rand);
  for (let i = 0; i < 5 && b.src === a.src; i++) b = cellAtom(rand);
  return { src: `${pref}${a.src}:${b.src}`, move: (dr, dc) => `${pref}${a.move(dr, dc)}:${b.move(dr, dc)}` };
}

function callAtom(rand) {
  const inside = rand() < 0.5 ? cellAtom(rand) : rangeAtom(rand);
  return { src: `SUM(${inside.src})`, move: (dr, dc) => `SUM(${inside.move(dr, dc)})` };
}

const stringAtom = (rand) => {
  const pick = ["A1", "B$2", "Q1 plan", "=C3", "SUM(A1)"][Math.floor(rand() * 5)];
  return { src: `"${pick}"`, move: () => `"${pick}"` };
};

const numberAtom = (rand) => {
  const n = String(1 + Math.floor(rand() * 99));
  return { src: n, move: () => n };
};

function atom(rand) {
  const roll = rand();
  if (roll < 0.3) return cellAtom(rand);
  if (roll < 0.55) return rangeAtom(rand);
  if (roll < 0.7) return callAtom(rand);
  if (roll < 0.85) return stringAtom(rand);
  return numberAtom(rand);
}

function formulaOf(rand) {
  const terms = [atom(rand), atom(rand), atom(rand)];
  const ops = [rand() < 0.5 ? "+" : "*", rand() < 0.5 ? "-" : "/"];
  return { terms, ops };
}

// Bug: a relative reference stayed put, a string's text moved, a $ part moved, an open range end
// did not move, or a function name was read as a column.
test("shiftFormula moves relative references and ranges by the shift and back again", () => {
  const { seeds } = seedWindowHelpers.seedWindow({ name: "sheet shift formula", full: 40, routine: 12 });
  let moved = 0;
  for (const seed of seeds) {
    const rand = mulberry32(seed);
    const { terms, ops } = formulaOf(rand);
    const source = `=${terms[0].src}${ops[0]}${terms[1].src}${ops[1]}${terms[2].src}`;
    const dr = Math.floor(rand() * 6) - 2;
    const dc = Math.floor(rand() * 6) - 2;
    if (dr === 0 && dc === 0) continue;
    const shifted = `=${terms[0].move(dr, dc)}${ops[0]}${terms[1].move(dr, dc)}${ops[1]}${terms[2].move(dr, dc)}`;
    if (shifted.includes("#REF!")) continue;
    if (shifted !== source) moved += 1;
    expect(`${seed}: ${shiftFormula(source, dr, dc, tokenize)}`).toBe(`${seed}: ${shifted}`);
    expect(`${seed}: ${shiftFormula(shifted, -dr, -dc, tokenize)}`).toBe(`${seed}: ${source}`);
  }
  expect(moved).toBeGreaterThan(0);
});

// Bug: an absolute reference moved with the shift.
test("absolute parts of a reference stay where they are", () => {
  expect(shiftFormula("=A1+B$2*$C3+$D$4", 1, 1, tokenize)).toBe("=B2+C$2*$C4+$D$4");
});

// Bug: the sheet prefix was dropped, or the far end of a column or row range did not move.
test("a quoted sheet prefix stays and both ends of a column or row range move", () => {
  expect(shiftFormula("='Q1 plan'!A1:B2", 2, 0, tokenize)).toBe("='Q1 plan'!A3:B4");
  expect(shiftFormula("=SUM(A:C)", 0, 1, tokenize)).toBe("=SUM(B:D)");
  expect(shiftFormula("=SUM(2:5)", 3, 0, tokenize)).toBe("=SUM(5:8)");
});

// Bug: a row moved above row 1 wrote row 0 instead of #REF!.
test("a reference moved off the sheet becomes #REF!", () => {
  expect(shiftFormula("=A1", -1, 0, tokenize)).toBe("=#REF!");
});

// Bug: a reference-shaped word inside a string moved.
test("text inside a quoted string does not move", () => {
  expect(shiftFormula('="A1"&B1', 0, 1, tokenize)).toBe('="A1"&C1');
});

// Bug: a function name was read as a column reference and moved.
test("a function name is not read as a column", () => {
  expect(shiftFormula("=SUM(B1)", 0, 1, tokenize)).toBe("=SUM(C1)");
});

// Bug: a token next to a word character or a row that is not a whole number moved.
test("tokens inside a word or with a fractional row are left alone", () => {
  expect(shiftFormula("=ITEM1", 1, 1, tokenize)).toBe("=ITEM1");
  expect(shiftFormula("=ABCD:EFGH", 0, 1, tokenize)).toBe("=ABCD:EFGH");
  expect(shiftFormula("=_A1", 1, 1, tokenize)).toBe("=_A1");
  expect(shiftFormula("=FOO.A1", 1, 1, tokenize)).toBe("=FOO.A1");
  expect(shiftFormula("=100A1", 1, 1, tokenize)).toBe("=100A1");
  expect(shiftFormula("=1.5:2", 1, 0, tokenize)).toBe("=1.5:2");
  expect(shiftFormula("=A1.5:2", 1, 0, tokenize)).toBe("=A1.5:2");
});

// Bug: the open end of a range written as a cell, colon, column triple did not move.
test("the open column end of a range moves with the shift", () => {
  expect(shiftFormula("=SUM(B2:B)", 0, 1, tokenize)).toBe("=SUM(C2:C)");
  expect(shiftFormula("=SUM($B$2:B)", 0, 1, tokenize)).toBe("=SUM($B$2:C)");
});

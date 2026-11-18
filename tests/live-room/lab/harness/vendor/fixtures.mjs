import { rng } from "./rng.mjs";
import { cell } from "./model.mjs";
import { keysBetween } from "./order-keys.mjs";

const TAG = { base: 12, patches: {} };
const REV = "12";

const COL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const COLUMNS = 20;

const VENDORS = ["Acme", "Borealis", "Cedar", "Delta", "Ember", "Fable", "Grove", "Harbor"];
const REGIONS = ["North", "South", "East", "West"];
const OWNERS = ["Ana", "Ben", "Cara", "Dev", "Eli", "Fay", "Gus", "Hana"];
const STATUSES = ["open", "closed", "pending", "review"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const HEADERS = [
  "Account",
  "Units",
  "Rate",
  "Qty",
  "Price",
  "Cost",
  "Tax",
  "Fee",
  "Margin",
  "Region",
  "Owner",
  "Status",
  "Budget",
  "Actual",
  "Share",
  "Date",
  "Sum",
  "Product",
  "Flag",
  "Ratio",
];

const nBetween = (random, min, max) => min + Math.floor(random() * (max - min + 1));

const grouping = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const moneyText = (value) => `$${grouping(value.toFixed(2))}`;

const percentText = (ratio) => `${Math.round(ratio * 100)}%`;

function dateParts(offset) {
  const d = new Date(Date.UTC(2024, 0, 1 + offset));
  const iso = d.toISOString().slice(0, 10);
  const text = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  return { iso, text };
}

function sheetId(prefix) {
  return prefix;
}

function tiny() {
  const sheetKeys = keysBetween(null, null, 2);
  const budgetCols = keysBetween(null, null, 3);
  const budgetRows = keysBetween(null, null, 6);
  const tripCols = keysBetween(null, null, 2);
  const tripRows = keysBetween(null, null, 2);

  const budget = {
    id: "s1",
    pos: sheetKeys[0],
    name: "Budget",
    freezeCols: 0,
    cols: [
      { id: "ca", pos: budgetCols[0], width: 180 },
      { id: "cb", pos: budgetCols[1], fmt: "$#,##0.00" },
      { id: "cc", pos: budgetCols[2], fmt: "0%" },
    ],
    rows: [
      {
        id: "r1",
        pos: budgetRows[0],
        frozen: true,
        cells: [
          cell("Item", { style: "font-weight:bold" }),
          cell("Cost"),
          cell("Share"),
        ],
      },
      {
        id: "r2",
        pos: budgetRows[1],
        frozen: false,
        cells: [
          cell("Rent"),
          cell("$1,200.00", { n: true, v: "1200" }),
          cell("80%", { n: true, f: "=B2/B$5", expect: 0.8 }),
        ],
      },
      {
        id: "r3",
        pos: budgetRows[2],
        frozen: false,
        cells: [
          cell("Food"),
          cell("$300.00", { n: true, v: "300" }),
          cell("20%", { n: true, f: "=B3/B$5", expect: 0.2 }),
        ],
      },
      { id: "r4", pos: budgetRows[3], frozen: false, cells: [] },
      {
        id: "r5",
        pos: budgetRows[4],
        frozen: false,
        cells: [
          cell("Total", { style: "font-weight:bold" }),
          cell("$1,500.00", { n: true, f: "=SUM(B2:B3)", expect: 1500 }),
        ],
      },
      {
        id: "r6",
        pos: budgetRows[5],
        frozen: false,
        cells: [
          cell("Prices as of November", { colspan: 3, style: "text-align:center" }),
          cell("", { hidden: true }),
          cell("", { hidden: true }),
        ],
      },
    ],
  };

  const trips = {
    id: "s2",
    pos: sheetKeys[1],
    name: "Trips",
    freezeCols: 0,
    cols: [
      { id: "cd", pos: tripCols[0] },
      { id: "ce", pos: tripCols[1] },
    ],
    rows: [
      {
        id: "r7",
        pos: tripRows[0],
        frozen: false,
        cells: [
          cell("Lisbon"),
          cell("Mar 14, 2026", { n: true, v: "2026-03-14", fmt: "mmm d, yyyy" }),
        ],
      },
      {
        id: "r8",
        pos: tripRows[1],
        frozen: false,
        cells: [
          cell("Budget left"),
          cell("$3,500.00", {
            n: true,
            f: "=5000-Budget!B5",
            fmt: "$#,##0.00",
            expect: 3500,
          }),
        ],
      },
    ],
  };

  return { rev: REV, sheets: [budget, trips], tag: TAG };
}

function buildLedger(prefix, random, dataRows) {
  const totalRows = dataRows + 2;
  const sheetKey = keysBetween(null, null, 1)[0];
  const colKeys = keysBetween(null, null, COLUMNS);
  const rowKeys = keysBetween(null, null, totalRows);

  const cols = colKeys.map((pos, i) => {
    const col = { id: `${prefix}-c${i}`, pos };
    if (i === 0) col.width = 180;
    if (i === 12 || i === 13) col.fmt = "$#,##0.00";
    if (i === 14) col.fmt = "0%";
    return col;
  });

  const rows = [];
  rows.push({
    id: `${prefix}-r0`,
    pos: rowKeys[0],
    frozen: true,
    cells: HEADERS.map((name) => cell(name)),
  });

  const bValues = [];
  const qValues = [];
  const rValues = [];
  const totals = { b: Array(8).fill(0), m: 0, n: 0, q: 0, r: 0 };
  let q2 = null;

  for (let row = 2; row <= dataRows + 1; row++) {
    const units = nBetween(random, 10, 9999);
    const rate = nBetween(random, 1, 99);
    const qty = nBetween(random, 1, 200);
    const price = Math.round(random() * 5000) / 100;
    const cost = Math.round(random() * 5000) / 100;
    const tax = Math.round(random() * 900) / 100;
    const fee = Math.round(random() * 200) / 100;
    const margin = Math.round(random() * 10000) / 100;
    const budget = Math.round(random() * 10000) / 100;
    const actual = Math.round(random() * 10000) / 100;
    const share = Math.round(random() * 10000) / 10000;
    const date = dateParts(nBetween(random, 0, 1095));
    const region = REGIONS[nBetween(random, 0, REGIONS.length - 1)];
    const owner = OWNERS[nBetween(random, 0, OWNERS.length - 1)];
    const status = STATUSES[nBetween(random, 0, STATUSES.length - 1)];
    const vendor = VENDORS[nBetween(random, 0, VENDORS.length - 1)];

    const plain = [units, rate, qty, price, cost, tax, fee, margin];
    plain.forEach((value, i) => {
      totals.b[i] += value;
    });

    const sum = plain.reduce((a, b) => a + b, 0);
    const product = units * rate;
    if (q2 === null) q2 = sum;
    const ratio = sum / q2;

    totals.m = Math.round((totals.m + budget) * 100) / 100;
    totals.n = Math.round((totals.n + actual) * 100) / 100;
    totals.q += sum;
    totals.r += product;

    bValues[row] = units;
    qValues[row] = sum;
    rValues[row] = product;

    rows.push({
      id: `${prefix}-r${row}`,
      pos: rowKeys[row - 1],
      frozen: false,
      cells: [
        cell(`${vendor} ${1000 + row}`),
        ...plain.map((value) => cell(String(value), { n: true })),
        cell(region),
        cell(owner),
        cell(status),
        cell(moneyText(budget), { n: true, v: String(budget), fmt: "$#,##0.00" }),
        cell(moneyText(actual), { n: true, v: String(actual), fmt: "$#,##0.00" }),
        cell(percentText(share), { n: true, v: String(share), fmt: "0%" }),
        cell(date.text, { n: true, v: date.iso, fmt: "mmm d, yyyy" }),
        cell(String(sum), { n: true, f: `=SUM(B${row}:I${row})`, expect: sum }),
        cell(String(product), { n: true, f: `=B${row}*C${row}`, expect: product }),
        cell(sum > 4000 ? "high" : "low", { f: `=IF(Q${row}>4000,"high","low")`, expect: sum > 4000 ? "high" : "low" }),
        cell(percentText(ratio), { n: true, f: `=Q${row}/Q$2`, fmt: "0%", expect: ratio }),
      ],
    });
  }

  const last = dataRows + 1;
  const totalRow = {
    id: `${prefix}-r${last + 1}`,
    pos: rowKeys[last],
    frozen: false,
    cells: [
      cell("Total", { style: "font-weight:bold" }),
      ...totals.b.map((sum, i) =>
        cell(String(sum), { n: true, f: `=SUM(${COL_LETTERS[1 + i]}2:${COL_LETTERS[1 + i]}${last})`, expect: sum }),
      ),
      cell("n/a"),
      cell("n/a"),
      cell("n/a"),
      cell(moneyText(totals.m), { n: true, f: `=SUM(M2:M${last})`, fmt: "$#,##0.00", expect: totals.m }),
      cell(moneyText(totals.n), { n: true, f: `=SUM(N2:N${last})`, fmt: "$#,##0.00", expect: totals.n }),
      cell("n/a"),
      cell("n/a"),
      cell(String(totals.q), { n: true, f: `=SUM(Q2:Q${last})`, expect: totals.q }),
      cell(String(totals.r), { n: true, f: `=SUM(R2:R${last})`, expect: totals.r }),
      cell("n/a"),
      cell("n/a"),
    ],
  };
  rows.push(totalRow);

  return {
    sheet: {
      id: sheetId(prefix),
      pos: sheetKey,
      name: "Ledger",
      freezeCols: 0,
      cols,
      rows,
    },
    bValues,
    qValues,
    rValues,
  };
}

function buildSummary(prefix, random, ledger, dataRows) {
  const totalRows = dataRows + 1;
  const sheetKey = keysBetween(null, null, 1)[0];
  const colKeys = keysBetween(null, null, COLUMNS);
  const rowKeys = keysBetween(null, null, totalRows);

  const cols = colKeys.map((pos, i) => {
    const col = { id: `${prefix}-c${i}`, pos };
    if (i === 0) col.width = 180;
    return col;
  });

  const rows = [
    {
      id: `${prefix}-r0`,
      pos: rowKeys[0],
      frozen: false,
      cells: HEADERS.map((name) => cell(name)),
    },
  ];

  for (let row = 2; row <= dataRows + 1; row++) {
    const q = ledger.qValues[row];
    const r = ledger.rValues[row];
    const b = ledger.bValues[row];
    rows.push({
      id: `${prefix}-r${row}`,
      pos: rowKeys[row - 1],
      frozen: false,
      cells: [
        cell(`Line ${row - 1}`),
        cell(String(q), { n: true, f: `=Ledger!Q${row}`, expect: q }),
        cell(String(r), { n: true, f: `=Ledger!R${row}`, expect: r }),
        cell(String(b), { n: true, f: `=Ledger!B${row}`, expect: b }),
        cell(String(q * 2), { n: true, f: `=Ledger!Q${row}*2`, expect: q * 2 }),
        ...Array.from({ length: 15 }, () => cell(String(nBetween(random, 1, 9999)), { n: true })),
      ],
    });
  }

  return {
    id: sheetId(prefix),
    pos: sheetKey,
    name: "Summary",
    freezeCols: 0,
    cols,
    rows,
  };
}

function standardSheetSizes(dataRows) {
  const ledger = buildLedger("L", rng(20260101), dataRows);
  const summaryCount = dataRows === 898 ? 99 : 499;
  const summary = buildSummary("S", rng(20260202), ledger, summaryCount);
  const sheetKeys = keysBetween(null, null, 2);
  ledger.sheet.pos = sheetKeys[0];
  summary.pos = sheetKeys[1];
  return { rev: REV, sheets: [ledger.sheet, summary], tag: TAG };
}

function standard() {
  return standardSheetSizes(898);
}

function stretch() {
  return standardSheetSizes(4498);
}

function chain() {
  const rowKeys = keysBetween(null, null, 1000);
  const colKeys = keysBetween(null, null, 1);
  const rows = Array.from({ length: 1000 }, (_, i) => {
    const row = i + 1;
    const value = row;
    const attrs = { n: true };
    if (row > 1) {
      attrs.f = `=A${row - 1}+1`;
      attrs.expect = value;
    }
    return {
      id: `C-r${row}`,
      pos: rowKeys[i],
      frozen: false,
      cells: [cell(String(value), attrs)],
    };
  });

  return {
    rev: REV,
    sheets: [
      {
        id: "C-s",
        pos: keysBetween(null, null, 1)[0],
        name: "Chain",
        freezeCols: 0,
        cols: [{ id: "C-c0", pos: colKeys[0], width: 120 }],
        rows,
      },
    ],
    tag: TAG,
  };
}

function filldown() {
  const random = rng(20260303);
  const rowKeys = keysBetween(null, null, 1000);
  const colKeys = keysBetween(null, null, COLUMNS);
  const firstRow = Array.from({ length: COLUMNS }, () => nBetween(random, 1, 999));
  const base = firstRow[1];
  const labels = VENDORS;

  const cols = colKeys.map((pos, i) => ({
    id: `F-c${i}`,
    pos,
    ...(i === 0 ? { width: 180 } : {}),
  }));

  const rows = [
    {
      id: "F-r1",
      pos: rowKeys[0],
      frozen: false,
      cells: firstRow.map((value) => cell(String(value), { n: true })),
    },
  ];

  for (let row = 2; row <= 1000; row++) {
    const cells = [cell(`${labels[(row - 2) % labels.length]} ${row}`)];
    for (let c = 1; c < COLUMNS; c++) {
      const value = firstRow[c] + (row - 1) * base;
      cells.push(
        cell(String(value), {
          n: true,
          f: `=$B$1+${COL_LETTERS[c]}${row - 1}`,
          expect: value,
        }),
      );
    }
    rows.push({ id: `F-r${row}`, pos: rowKeys[row - 1], frozen: false, cells });
  }

  return {
    rev: REV,
    sheets: [
      {
        id: "F-s",
        pos: keysBetween(null, null, 1)[0],
        name: "Filldown",
        freezeCols: 0,
        cols,
        rows,
      },
    ],
    tag: TAG,
  };
}

function sparse() {
  const random = rng(20260404);
  const rowKeys = keysBetween(null, null, 200);
  const colKeys = keysBetween(null, null, 200);

  const cols = colKeys.map((pos, i) => ({ id: `P-c${i}`, pos }));
  const rows = [];

  for (let row = 0; row < 200; row++) {
    const cells = [];
    for (let c = 0; c < 200; c++) {
      if (random() < 0.02) {
        const numeric = random() < 0.6;
        cells.push(
          numeric
            ? cell(String(nBetween(random, 1, 9999)), { n: true })
            : cell(VENDORS[nBetween(random, 0, VENDORS.length - 1)]),
        );
      } else {
        cells.push(null);
      }
    }
    while (cells.length > 0 && cells[cells.length - 1] === null) cells.pop();
    rows.push({ id: `P-r${row + 1}`, pos: rowKeys[row], frozen: false, cells });
  }

  return {
    rev: REV,
    sheets: [
      {
        id: "P-s",
        pos: keysBetween(null, null, 1)[0],
        name: "Sparse",
        freezeCols: 0,
        cols,
        rows,
      },
    ],
    tag: TAG,
  };
}

export const FIXTURES = { tiny, standard, stretch, chain, filldown, sparse };

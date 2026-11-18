import { jest } from "@jest/globals";

let snapshot;
let regions;

const ROUNDS = 31;

function bytesFor(cells) {
  const rows = [];
  for (let r = 0; r < cells / 20; r++) {
    const tds = [];
    for (let c = 0; c < 20; c++) tds.push(`<td n v=${r * 20 + c}>${r * 20 + c}</td>`);
    rows.push(`<tr>${tds.join("")}</tr>`);
  }
  return `<tbody>${rows.join("")}</tbody>`;
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function measure(run, rounds = ROUNDS) {
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    run();
    times.push(performance.now() - started);
  }
  return median(times);
}

function page(cells) {
  const bytes = bytesFor(cells);
  document.body.innerHTML = `<header><h1>Budget</h1></header><section item data-id="tab-1"><table grid>${bytes}</table></section><p>after</p>`;
  return bytes;
}

beforeAll(async () => {
  window.clayEditMode = true;
  snapshot = await import("../../src/core/snapshot.js");
  regions = await import("../../src/lib/owned-regions.js");
});

test("an owned region of 20,000 cells saves and compares in the time of an empty one", () => {
  const sizes = {};
  for (const cells of [0, 20000]) {
    const bytes = page(cells);
    const calls = { serialize: 0, revision: 0 };
    const handle = regions.own("section[item] > table[grid]", {
      serialize: () => { calls.serialize++; return bytes; },
      revision: () => { calls.revision++; return 7; },
    });
    const first = snapshot.captureForSaveAndComparison({ emitForSync: false });
    const clone = snapshot.captureSnapshot({ flushUndo: false });
    sizes[cells] = {
      bytes: bytes.length,
      forSave: first.forSave.length,
      forComparison: first.forComparison.length,
      cloneElements: clone.querySelectorAll("*").length,
      save: measure(() => snapshot.captureForSaveAndComparison({ emitForSync: false })),
      dirty: measure(() => snapshot.captureForDirtyCheck({ flushUndo: false })),
    };
    expect(first.forSave).toContain(`<table grid="">${bytes}</table>`);
    expect(calls.serialize).toBe(2 + ROUNDS);
    handle.dispose();
  }
  page(20000);
  sizes.generic = {
    save: measure(() => snapshot.captureForSaveAndComparison({ emitForSync: false }), 3),
    dirty: measure(() => snapshot.captureForDirtyCheck({ flushUndo: false }), 3),
  };
  console.log(JSON.stringify(sizes));
  expect(sizes[20000].cloneElements).toBe(sizes[0].cloneElements);
  expect(sizes[20000].forComparison).toBe(sizes[0].forComparison);
  expect(sizes[20000].forSave - sizes[0].forSave).toBe(sizes[20000].bytes - sizes[0].bytes);
  expect(sizes[20000].dirty / sizes[0].dirty).toBeLessThan(3);
  expect(sizes[20000].save / sizes[0].save).toBeLessThan(3);
  expect(sizes.generic.save / sizes[20000].save).toBeGreaterThan(10);
}, 120000);

// Fractional-index tokens sapjs accepts (`pos`), in their own order: the digits, the
// capitals, the lowercase letters. Two characters is enough for 3,782 rows.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function positions(count) {
  const out = [];
  for (const a of ALPHABET) {
    for (const b of ALPHABET) {
      if (b === "0") continue;
      out.push(a + b);
      if (out.length === count) return out;
    }
  }
  return out;
}

const COLS = 20;

function workbookPage(cells) {
  const rows = cells / COLS;
  const pos = positions(Math.max(rows, COLS));
  const cols = Array.from({ length: COLS }, (_, c) => `<col data-id="c${c + 1}" data-pos="${pos[c]}">`).join("");
  let body = "";
  for (let r = 0; r < rows; r++) {
    const tds = [];
    for (let c = 0; c < COLS; c++) tds.push(`<td n v="${r * COLS + c}">${r * COLS + c}</td>`);
    body += `<tr data-id="r${r + 1}" data-pos="${pos[r]}">${tds.join("")}</tr>\n`;
  }
  return `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup>${cols}</colgroup>
<tbody>
${body}</tbody></table></section>
</div>
</main>`;
}

// The real workbook owner on a booted page: the engine, its Grids and sapjs's cached
// writer. `ownWorkbooks` registers its region once and has no dispose, so each size
// gets a fresh module registry.
async function bootWorkbook(cells, { owned = true } = {}) {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.Sap;
  delete window.sapPlugins;
  window.clay = { ready: new Promise(() => {}) };
  document.head.innerHTML = "";
  document.body.innerHTML = workbookPage(cells);
  const Sap = (await import("../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../src/sheet/workbook.js");
  const books = owned ? ownWorkbooks({}) : null;
  await books?.ready;
  Sap.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const snapshot = await import("../../src/core/snapshot.js");
  const book = books?.books.get(document.querySelector("[sheet-workbook]")) ?? null;
  return { book, snapshot, Sap };
}

// The bound is the generic save of the same page, as the row above uses: jsdom's selector
// engine walks every element for ClayJS's `[sheet-workbook]` lookup (22 ms at 20,000 cells,
// against 0.005 ms for a tag selector), so a ratio to an empty page measures jsdom, not the
// owner. A browser does that lookup natively.
test("the sheet's workbook owner saves 20,000 cells many times faster than the generic save", async () => {
  const owned = await bootWorkbook(20000);
  const first = owned.snapshot.captureForSaveAndComparison({ emitForSync: false });
  expect(first.forSave).toContain("<table grid");
  expect(owned.book.revision).toBe(0);
  const sizes = { owned: { bytes: first.forSave.length, save: measure(() => owned.snapshot.captureForSaveAndComparison({ emitForSync: false })) } };
  owned.Sap.unmount();

  const generic = await bootWorkbook(20000, { owned: false });
  sizes.generic = { save: measure(() => generic.snapshot.captureForSaveAndComparison({ emitForSync: false }), 3) };
  generic.Sap.unmount();
  console.log(JSON.stringify(sizes));
  expect(sizes.generic.save / sizes.owned.save).toBeGreaterThan(10);
}, 180000);

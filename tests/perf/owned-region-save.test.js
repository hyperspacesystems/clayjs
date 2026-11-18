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

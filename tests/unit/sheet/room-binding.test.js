/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, expect, jest, test } from "@jest/globals";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function page(body) {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.Sap;
  delete window.sapPlugins;
  delete window.clayEditMode;
  window.clay = { ready: new Promise(() => {}) };
  document.head.innerHTML = "";
  document.body.innerHTML = body;
}

const FIGURE =
  '<figure chart="k1" sap-ignore=""><svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80" role="img" aria-label="Chart: column"><title>Chart: column</title><desc>Series 1: 1: 3</desc><g><rect x="10" y="10" width="20" height="60" fill="#3170b8"></rect></g></svg></figure>';

const BOOK = () => `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="1">1</td><td n v="2">2</td><td n f="=A1+B1" v="3">3</td></tr>
<tr data-id="r2" data-pos="l"><td n v="4">4</td><td n v="5">5</td><td n></td></tr>
<tr data-id="r3" data-pos="t"><td n></td><td n></td><td n></td></tr>
</tbody><template rules>
<rule data-id="k1" data-pos="V" kind="chart" range="A1:B3" source="A1:B3" type="column"></rule>
</template></table>
${FIGURE}</section>
<script type="application/json" sheet-commit>{"rev":2}</script>
</div>
</main>`;

async function start(body = BOOK()) {
  page(body);
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const { createRoomBinding } = await import("../../../src/sheet/room.js");
  const books = ownWorkbooks({});
  await books.ready;
  Sap.mount();
  await turn();
  const root = document.querySelector("[sheet-workbook]");
  const book = books.books.get(root);
  const grid = Sap.grid(root.querySelector('section[data-id="s1"] table[grid]'));
  const room = fakeRoom(Sap.grid.roomCodec, book.serialize({ purpose: "recovery" }));
  const notice = jest.fn();
  const binding = createRoomBinding(book, { Sap, notice });
  const original = grid.dispatch.bind(grid);
  grid.dispatch = binding.dispatchFor(grid, original);
  return { Sap, books, book, root, grid, room, binding, notice, original };
}

// A room that keeps one doc and lets a test play a coworker.
function fakeRoom(codec, inner) {
  let { doc } = codec.read(inner);
  const listeners = new Set();
  const submitted = [];
  let n = 0;
  return {
    ready: Promise.resolve(),
    status: { mode: "ordered", pending: 0 },
    submitted,
    view: () => JSON.parse(JSON.stringify(doc)),
    submit(action) {
      submitted.push(action);
      const out = codec.apply(doc, action);
      if (out.out !== "applied") return null;
      doc = out.doc ?? doc;
      n += 1;
      for (const listener of listeners) listener({ type: "change" });
      return { id: `me:${n}`, admitted: Promise.resolve(), durable: Promise.resolve() };
    },
    peer(action) {
      const out = codec.apply(doc, action);
      if (out.out !== "applied") throw new Error(`the peer's action was ${out.out}`);
      doc = out.doc ?? doc;
      for (const listener of listeners) listener({ type: "change" });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const tableOf = (id = "s1") => document.querySelector(`section[data-id="${id}"] table[grid]`);
const cellAt = (r, c) => tableOf().querySelectorAll("tbody tr")[r].children[c];
const ROW_ABOVE = { v: 1, t: "insertRows", sheet: "s1", rows: [{ id: "r0", pos: "d" }] };

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  jest.restoreAllMocks();
});

// Bug: the dispatch hook applied the edit and never sent it, so no coworker saw it.
test("a local edit shows at once, goes to the room, and moves no revision", async () => {
  const { book, grid, room, binding } = await start();
  await binding.start(room);

  grid.set("B2", "7");

  expect(cellAt(1, 1).textContent).toBe("7");
  expect(room.submitted).toHaveLength(1);
  expect(room.view().tabs[0].sheet.rows[1].cells[1].text).toBe("7");
  expect(book.revision).toBe(0);
  expect(binding.canUndo("s1")).toBe(true);
});

// Bug: a peer's change never reached the page, so the two tabs drifted apart.
test("a peer's change reaches the DOM without an undo entry and without a revision", async () => {
  const { book, room, binding } = await start();
  await binding.start(room);

  room.peer({ v: 1, t: "set", sheet: "s1", cells: [["r3", "c2", 9]] });

  expect(cellAt(2, 1).textContent).toBe("9");
  expect(book.revision).toBe(0);
  expect(binding.canUndo("s1")).toBe(false);
});

// Bug: reconcile left rows out, so a peer's insert never moved the cells below it.
test("a peer's row insert above a cell moves that cell down the page", async () => {
  const { room, binding } = await start();
  await binding.start(room);

  room.peer(ROW_ABOVE);

  expect(tableOf().querySelectorAll("tbody tr")).toHaveLength(4);
  expect(cellAt(2, 1).textContent).toBe("5");
});

// Bug: the action went to the room unbound, so a peer's insert admitted first changed what its
// formulas meant.
test("a formula is submitted with the refs it means in this tab's frame", async () => {
  const { grid, room, binding } = await start();
  await binding.start(room);

  grid.set("C2", "=A1+B1");

  const sent = room.submitted.at(-1);
  expect(sent.cells[0][2].refs.length).toBeGreaterThan(0);
  expect(sent.cells[0][2].f).toBe("=A1+B1");
});

// Bug: undo submitted its revert without the probe, so it overwrote a coworker's later change.
test("undo leaves a value a coworker changed since and says why", async () => {
  const { grid, room, binding, notice } = await start();
  await binding.start(room);
  grid.set("B2", "7");
  room.peer({ v: 1, t: "set", sheet: "s1", cells: [["r2", "c2", 9]] });

  const result = binding.undo("s1");

  expect(result).toEqual({ ok: false, why: "changed", skipped: ["s1/r2/c2"] });
  expect(cellAt(1, 1).textContent).toBe("9");
  expect(notice).toHaveBeenCalledWith(expect.stringContaining("Sheet1!B2"));
});

// Bug: an undo or redo replayed the DOM inverse instead of the room's, so it landed on a row a
// coworker's insert had moved.
test("undo and redo of a value a peer's insert moved land on the moved row", async () => {
  const { grid, room, binding } = await start();
  await binding.start(room);
  grid.set("B2", "7");
  room.peer(ROW_ABOVE);
  expect(cellAt(2, 1).textContent).toBe("7");

  expect(binding.undo("s1").ok).toBe(true);
  expect(cellAt(2, 1).textContent).toBe("5");

  expect(binding.redo("s1").ok).toBe(true);
  expect(cellAt(2, 1).textContent).toBe("7");
});

// Bug: extras ignored whether the room was quiet, so a save wrote results from a drifted page and
// dropped a drawing it never had.
test("the room's save carries results and the page's drawing only while quiet", async () => {
  const { Sap, room, binding, root } = await start();
  await binding.start(room);
  const figure = root.querySelector('section[data-id="s1"] figure[chart]');
  figure.innerHTML = figure.innerHTML.replace("#3170b8", "#ff0000");
  const inner = binding.committedInner();
  const base = `<html><body><main sap plugins="grid"><div items="sheets" sheet-workbook>${inner}</div></main></body></html>`;

  room.status.pending = 1;
  const pending = binding.page(inner, base);
  expect(pending).toMatch(/<table grid[^>]*stale/);
  expect(pending).toContain("#3170b8");
  expect(pending).not.toContain("#ff0000");

  room.status.pending = 0;
  const quiet = binding.page(inner, base);
  expect(quiet).not.toMatch(/<table grid[^>]*stale/);
  expect(quiet).toMatch(/>3</);
  expect(quiet).toContain("#ff0000");
  expect(Sap).toBeTruthy();
});

// Bug: a page save in a room wrote the live tabs, so it raced the room's own save.
test("a page save while bound hands back the committed region byte for byte", async () => {
  const { book, grid, room, binding } = await start();
  await binding.start(room);
  const committed = binding.committedInner();

  grid.set("B2", "7");

  expect(book.serialize({ purpose: "save" })).toBe(committed);
  expect(book.serialize({ purpose: "recovery" })).not.toBe(committed);
});

// Bug: the quiet check always passed, so a write around the room stayed in the page and the next
// save made the file disagree with the room.
test("the quiet check repairs a cell written around the room and fires one drift event", async () => {
  const { grid, room, binding, original } = await start();
  await binding.start(room);
  const drift = jest.fn();
  document.addEventListener("sheet:view-drift", drift);

  original({ v: 1, t: "set", sheet: "s1", cells: [["r1", "c1", 99]] });
  expect(cellAt(0, 0).textContent).toBe("99");

  expect(binding.quietCheck()).toBe(false);
  expect(cellAt(0, 0).textContent).toBe("1");
  expect(drift).toHaveBeenCalledTimes(1);
  expect(drift.mock.calls[0][0].detail.differences).toBeGreaterThan(0);
  expect(binding.quietCheck()).toBe(true);
});

// Bug: an edit made before the room was ready was dropped, so the first seconds of work were lost.
test("an edit before ready is in the DOM at once and is submitted when ready", async () => {
  const { grid, room, binding } = await start();

  const joined = binding.start(room);
  grid.set("B2", "7");

  expect(cellAt(1, 1).textContent).toBe("7");
  expect(room.submitted).toHaveLength(0);

  await joined;

  expect(room.submitted).toHaveLength(1);
  expect(cellAt(1, 1).textContent).toBe("7");
  expect(room.view().tabs[0].sheet.rows[1].cells[1].text).toBe("7");
});

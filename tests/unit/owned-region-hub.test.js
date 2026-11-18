import { jest } from "@jest/globals";

let Mutation;
let regions;
let gate;

const CELLS = 19000;
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function grid(cells) {
  const rows = [];
  for (let r = 0; r < cells / 20; r++) rows.push(`<tr>${"<td>0</td>".repeat(20)}</tr>`);
  return `<section item data-id="tab-1"><table grid><tbody>${rows.join("")}</tbody></table></section><p id="outside">text</p>`;
}

function counted(names) {
  const counts = {};
  const spies = names.map((name) => {
    counts[name] = 0;
    const original = Element.prototype[name];
    return jest.spyOn(Element.prototype, name).mockImplementation(function (...args) { counts[name]++; return original.apply(this, args); });
  });
  return { counts, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

const register = ({ selector, ...spec }) => regions.own(selector, spec);
let release = null;
let stop = [];
let owner;

beforeAll(async () => {
  window.clayEditMode = true;
  Mutation = (await import("../../src/lib/mutation.js")).default;
  regions = await import("../../src/lib/owned-regions.js");
  gate = await import("../../src/lib/dirty-gate.js");
});

async function mount(cells) {
  document.body.innerHTML = grid(cells);
  owner = { rev: 1, revisionCalls: 0, fail: false };
  release = register({
    selector: "section[item] > table[grid]",
    serialize: () => "",
    revision: () => { owner.revisionCalls++; if (owner.fail) throw new Error("no revision"); return owner.rev; },
  });
  await turn();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
  owner.revisionCalls = 0;
}

afterEach(async () => {
  for (const off of stop) off();
  stop = [];
  document.body.innerHTML = "";
  await turn();
  release?.dispose();
  release = null;
});

function listen(options) {
  const calls = [];
  stop.push(Mutation.onAnyChange({ debounce: 0, ...options }, (changes) => { calls.push(changes); }));
  return calls;
}

test("19,000 cell writes inside an owned region reach subscribers as one change and cost no per record policy work", async () => {
  await mount(CELLS);
  const autosave = listen({ omitChangeDetails: true, require: "autosave" });
  const detailed = listen({});
  const cells = document.querySelectorAll("td");
  expect(cells.length).toBe(CELLS);
  const processed = [];
  const original = Mutation._processMutations;
  const timing = jest.spyOn(Mutation, "_processMutations").mockImplementation(function (records, only) {
    const started = performance.now();
    const result = original.call(this, records, only);
    processed.push({ records: records.length, ms: performance.now() - started });
    return result;
  });
  const spy = counted(["closest", "matches", "querySelectorAll", "hasAttribute"]);
  for (let i = 0; i < CELLS; i++) cells[i].textContent = String(i);
  owner.rev = 2;
  await turn();
  spy.restore();
  for (let i = 0; i < CELLS; i++) cells[i].textContent = `again ${i}`;
  await turn();
  for (let i = 0; i < CELLS; i++) cells[i].firstChild.data = `text ${i}`;
  await turn();
  timing.mockRestore();
  console.log("hub", JSON.stringify(processed), JSON.stringify(spy.counts));
  expect(processed.map((call) => call.records)).toEqual([CELLS, CELLS, CELLS]);
  expect(autosave.length).toBe(1);
  expect(detailed.length).toBe(1);
  expect(detailed[0].length).toBe(1);
  expect(detailed[0][0].type).toBe("owned");
  expect(detailed[0][0].element).toBe(document.querySelector("table[grid]"));
  expect(owner.revisionCalls).toBe(3);
  expect(spy.counts.querySelectorAll).toBe(0);
  expect(spy.counts.closest).toBeLessThan(20);
  expect(spy.counts.matches).toBeLessThan(20);
  expect(spy.counts.hasAttribute).toBeLessThan(200);
  expect(gate.pageMaybeDirty()).toBe(true);
});

test("writes that do not move the revision tell nobody", async () => {
  await mount(600);
  const autosave = listen({ omitChangeDetails: true, require: "autosave" });
  const cells = document.querySelectorAll("td");
  for (let i = 0; i < 500; i++) cells[i].textContent = "repaint";
  cells[3].setAttribute("class", "selected");
  await turn();
  expect(autosave.length).toBe(0);
  expect(owner.revisionCalls).toBe(1);
  expect(gate.pageMaybeDirty()).toBe(false);
});

test("a revision that throws counts as a change every time and is reported once", async () => {
  await mount(40);
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  const autosave = listen({ omitChangeDetails: true, require: "autosave" });
  owner.fail = true;
  document.querySelector("td").textContent = "typed";
  await turn();
  document.querySelector("td").textContent = "typed again";
  await turn();
  const reports = spy.mock.calls.length;
  spy.mockRestore();
  expect(autosave.length).toBe(2);
  expect(reports).toBe(1);
  expect(gate.pageMaybeDirty()).toBe(true);
});

test("the raw lane that undo records from gets nothing from inside an owned region", async () => {
  await mount(40);
  const pushed = [];
  const raw = Mutation.subscribeRaw((records) => { pushed.push(...records); });
  stop.push(() => raw.unsubscribe());
  const cells = document.querySelectorAll("td");
  const outside = document.getElementById("outside");
  for (let i = 0; i < 40; i++) cells[i].textContent = "typed";
  document.querySelector("tbody").appendChild(document.createElement("tr"));
  outside.setAttribute("data-edited", "1");
  await turn();
  expect(pushed.length).toBe(1);
  expect(pushed[0].target).toBe(outside);
  cells[0].textContent = "again";
  outside.setAttribute("data-edited", "2");
  document.querySelector("table[grid]").setAttribute("data-zoom", "2");
  const pulled = raw.drain();
  expect(pulled.map((record) => record.attributeName)).toEqual(["data-edited", "data-zoom"]);
  release.dispose();
  release = null;
  cells[1].textContent = "generic";
  expect(raw.drain().length).toBeGreaterThan(0);
});

test("the owner reports a change that touched no node", async () => {
  await mount(40);
  const autosave = listen({ omitChangeDetails: true, require: "autosave" });
  release.notify();
  await turn();
  expect(autosave.length).toBe(0);
  owner.rev = 5;
  release.notify(document.querySelector("table[grid]"));
  await turn();
  expect(autosave.length).toBe(1);
  expect(gate.pageMaybeDirty()).toBe(true);
});

test("with one owned region inside another, the outer owner's revision decides, as it does for captures", async () => {
  document.body.innerHTML = `<div sheet-workbook>${grid(40)}</div>`;
  owner = { rev: 1, revisionCalls: 0, fail: false };
  release = register({ selector: "section[item] > table[grid]", serialize: () => "", revision: () => owner.rev });
  const outer = { rev: 1 };
  const outerRelease = register({ selector: "[sheet-workbook]", serialize: () => "", revision: () => outer.rev });
  stop.push(() => outerRelease.dispose());
  await turn();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
  const autosave = listen({ omitChangeDetails: true, require: "autosave" });
  document.querySelector("td").textContent = "typed";
  outer.rev = 2;
  await turn();
  expect(autosave.length).toBe(1);
  expect(gate.pageMaybeDirty()).toBe(true);
});

test("a change outside the region and on the region's own attributes takes the generic path", async () => {
  await mount(40);
  const detailed = listen({});
  document.getElementById("outside").textContent = "edited";
  document.querySelector("table[grid]").setAttribute("data-zoom", "2");
  await turn();
  const types = detailed.flat().map((change) => change.type).sort();
  expect(types).toContain("attribute");
  expect(types.length).toBeGreaterThan(1);
  expect(types).not.toContain("owned");
  expect(owner.revisionCalls).toBe(0);
});

test("an added subtree is expanded up to an owned root and not into it", async () => {
  await mount(40);
  const detailed = listen({});
  const holder = document.createElement("div");
  holder.innerHTML = `<section item data-id="tab-2"><table grid><tbody><tr>${"<td>1</td>".repeat(500)}</tr></tbody></table></section>`;
  document.body.appendChild(holder);
  await turn();
  const added = detailed.flat().filter((change) => change.type === "add").map((change) => change.element.localName);
  expect(added).toEqual(["div", "section", "table"]);
});

test("with no region registered an added subtree is expanded in full", async () => {
  await mount(40);
  release.dispose();
  release = null;
  const detailed = listen({});
  const holder = document.createElement("div");
  holder.innerHTML = `<section item><table grid><tbody><tr>${"<td>1</td>".repeat(50)}</tr></tbody></table></section>`;
  document.body.appendChild(holder);
  document.querySelector("td").textContent = "generic";
  await turn();
  const changes = detailed.flat();
  expect(changes.filter((change) => change.type === "add").length).toBe(55);
  expect(changes.some((change) => change.type === "owned")).toBe(false);
});

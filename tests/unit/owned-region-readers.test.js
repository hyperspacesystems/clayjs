let snapshot;
let regions;
let derived;
let save;

const PAGE = '<main sap><p text="\'hi\'">hi</p><section item><table grid><tbody><tr><td n="1" text="\'x\'">x</td></tr></tbody></table></section></main>';
const SELECTOR = "section[item] > table[grid]";
const BYTES = '<tbody><tr><td text="\'x\'">owner</td></tr></tbody>';

beforeAll(async () => {
  window.clayEditMode = true;
  globalThis.Response ??= class { constructor(body, { status = 200 } = {}) { this.body = body; this.status = status; } };
  window.fetch = async () => new Response("", { status: 404 });
  document.body.innerHTML = PAGE;
  snapshot = await import("../../src/core/snapshot.js");
  regions = await import("../../src/lib/owned-regions.js");
  derived = await import("../../src/lib/derived.js");
  save = await import("../../src/core/save.js");
  await import("../../src/plugins/demo.js");
});

let handle = null;
let serialized = 0;
beforeEach(() => {
  document.body.innerHTML = PAGE;
  localStorage.clear();
  serialized = 0;
  handle = regions.own(SELECTOR, { serialize: () => { serialized++; return BYTES; }, revision: () => 1 });
});
afterEach(() => { handle?.dispose(); handle = null; });

test("the demo plugin stores the owner's bytes and no marker", async () => {
  snapshot.captureForSaveAndComparison();
  const response = await window.fetch("/_/save", { method: "POST", body: "" });
  expect(response.status).toBe(200);
  const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key)).join("");
  expect(stored).toContain("<td text=\"'x'\">owner</td>");
  expect(stored).not.toContain("clay-owned");
});

test("the painted values of the page leave region roots out, as the file side does, and ask the owner for no bytes", () => {
  const file = `<!DOCTYPE html><html><head></head><body>${PAGE.replace('n="1"', 'n="2"')}</body></html>`;
  expect(derived.paintSignatureOfHtml(file)).toBe(save.currentPaintSignature());
  expect(serialized).toBe(0);
  handle.dispose();
  handle = null;
  expect(derived.paintSignatureOfHtml(file)).not.toBe(save.currentPaintSignature());
});

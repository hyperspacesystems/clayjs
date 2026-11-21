/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
// C10 gate: two real sheet workbooks (Ana and Ben), each joined through its own room client
// against one reference host. Covers all 16 cases of plan-v2/c10-clayjs-sheet.md section 10.
import { afterEach, expect, jest, test } from "@jest/globals";
import { deserialize, serialize as v8Serialize } from "node:v8";
import { createReferenceHost } from "../../live-room/host/reference-host.mjs";
import { connect, createRoomClient } from "../../../src/live-room/room-client.js";
import { freshRecord } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits } from "../../../src/live-room/core/limits.js";
import { findRegion } from "../../../src/live-room/region.js";

if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = (value) => deserialize(v8Serialize(value));
}
if (typeof globalThis.Headers !== "function") {
  globalThis.Headers = class Headers {
    constructor(init = {}) {
      this._m = new Map();
      const entries = init instanceof Headers ? init._m.entries() : Object.entries(init ?? {});
      for (const [k, v] of entries) this._m.set(String(k).toLowerCase(), String(v));
    }
    get(k) {
      return this._m.get(String(k).toLowerCase()) ?? null;
    }
    set(k, v) {
      this._m.set(String(k).toLowerCase(), String(v));
    }
    has(k) {
      return this._m.has(String(k).toLowerCase());
    }
    entries() {
      return this._m.entries();
    }
    [Symbol.iterator]() {
      return this._m.entries();
    }
  };
}
if (typeof globalThis.Response !== "function") {
  globalThis.Response = class Response {
    constructor(body = "", init = {}) {
      this._body = body == null ? "" : String(body);
      this.status = init.status ?? 200;
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new globalThis.Headers(init.headers ?? {});
    }
    async text() {
      return this._body;
    }
    async json() {
      return JSON.parse(this._body);
    }
    clone() {
      return new globalThis.Response(this._body, { status: this.status, headers: this.headers });
    }
  };
}
if (typeof globalThis.Request !== "function") {
  globalThis.Request = class Request {
    constructor(input, init = {}) {
      this.url = typeof input === "string" ? input : String(input?.url ?? input);
      this.method = (init.method ?? "GET").toUpperCase();
      this.headers = new globalThis.Headers(init.headers ?? {});
      this._body = init.body == null ? "" : String(init.body);
    }
    async text() {
      return this._body;
    }
    async json() {
      return JSON.parse(this._body);
    }
    clone() {
      return new globalThis.Request(this.url, { method: this.method, headers: this.headers, body: this._body });
    }
  };
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("the condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const FIGURE_ORIG =
  '<figure chart="ch1" sap-ignore=""><svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80" role="img" aria-label="Chart: column"><title>Chart: column</title><desc>Series 1: 1: 3</desc><g><rect x="10" y="10" width="20" height="60" fill="#3170b8"></rect></g></svg></figure>';

const INITIAL_INNER = ({ chart = false } = {}) =>
  `<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="1">1</td><td n v="2">2</td><td n f="=A1+B1" v="3">3</td></tr>
<tr data-id="r2" data-pos="l"><td n v="4">4</td><td n v="5">5</td><td n></td></tr>
<tr data-id="r3" data-pos="t"><td n></td><td n></td><td n></td></tr>
</tbody>${chart ? '<template rules><rule data-id="ch1" data-pos="V" kind="chart" range="A1:B3" source="A1:B3" type="column"></rule></template>' : ""}</table>${chart ? FIGURE_ORIG : ""}</section>
<script type="application/json" sheet-commit>${JSON.stringify(freshRecord("doc0123456789abc"))}</script>`;

const wrapPage = (inner) =>
  `<!DOCTYPE html><html><body><main sap plugins="grid"><div items="sheets" sheet-workbook>${inner}</div></main></body></html>`;

const openClients = [];
const openBindings = [];
const openUIs = [];

afterEach(async () => {
  for (const b of openBindings.splice(0)) b.stop();
  for (const u of openUIs.splice(0)) u.dispose();
  await Promise.all(openClients.splice(0).map((c) => c.close()));
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  jest.restoreAllMocks();
});

async function setupPair({ chart = false, allowDrift = false, mountUI = false, autoStart = true } = {}) {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.Sap;
  delete window.sapPlugins;
  delete window.clayEditMode;
  window.clay = { ready: Promise.resolve() };
  document.head.innerHTML = "";

  const startInner = INITIAL_INNER({ chart });
  document.body.innerHTML = `
    <div id="ana-wrap"><main sap plugins="grid"><div items="sheets" sheet-workbook data-who="ana">${startInner}</div></main></div>
    <div id="ben-wrap"><main sap plugins="grid"><div items="sheets" sheet-workbook data-who="ben">${startInner}</div></main></div>
  `;

  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { startShell, sheetHooks } = await import("../../../src/sheet/shell.js");
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const { startInterface } = await import("../../../src/sheet/interface.js");
  const { createRoomBinding } = await import("../../../src/sheet/room.js");

  const shell = startShell();
  const uiByRoot = new Map();
  const bindingByRoot = new Map();
  const origByGrid = new Map();
  const wrapTabGrids = (book) => {
    const b = bindingByRoot.get(book.root);
    if (!b) return;
    for (const table of book.root.querySelectorAll(":scope > section[item] > table[grid]")) {
      const g = Sap.grid(table);
      if (origByGrid.has(g)) continue;
      origByGrid.set(g, g.dispatch);
      g.dispatch = b.dispatchFor(g, g.dispatch.bind(g));
    }
  };
  const books = ownWorkbooks({
    onRebuild: () => {
      shell.restart();
      for (const book of books.books.values()) wrapTabGrids(book);
      for (const ui of uiByRoot.values()) ui.restart();
    },
  });
  sheetHooks.bookOf = (el) => books.books.get(el) ?? null;

  await books.ready;
  Sap.mount();
  await turn();

  const codec = Sap.grid.roomCodec;
  useCodec(codec);
  let ids = 0;
  const host = createReferenceHost({
    codecs: { sheet: codec },
    codec: "sheet",
    rooms: { limits: labLimits(), newId: () => 1000 * ++ids },
  });
  host.put("doc", startInner);

  const drifts = [];
  const onDrift = (e) => drifts.push(e.detail);
  document.addEventListener("sheet:view-drift", onDrift);

  const makeSide = async (who, firstId) => {
    const root = document.querySelector(`[data-who="${who}"]`);
    const book = books.books.get(root);
    const notices = [];
    let ui = null;
    if (mountUI) {
      ui = startInterface({ shell, root: root.parentElement });
      openUIs.push(ui);
      uiByRoot.set(root, ui);
    }
    const binding = createRoomBinding(book, {
      Sap,
      notice: (text, action) => {
        notices.push(text);
        ui?.notice?.(text, action);
      },
      quietMs: 0,
    });
    openBindings.push(binding);
    bindingByRoot.set(root, binding);
    wrapTabGrids(book);

    // Bridge the reference host's save route through binding.page(inner, base) so room saves carry
    // formula results and drawings, matching browserTransport.
    const fetchWithPage = async (url, init = {}) => {
      if ((init.method ?? "GET").toUpperCase() === "POST" && url.includes("/_/save")) {
        const base = wrapPage(host.file("doc").bytes);
        const full = binding.page(String(init.body ?? ""), base);
        const region = findRegion(full);
        return host.fetch(url, { ...init, body: region.inner });
      }
      return host.fetch(url, init);
    };

    const client = createRoomClient({
      page: "doc",
      codec,
      clientId: who,
      fetch: fetchWithPage,
      subscribe: host.subscribe,
      limits: labLimits(),
      firstId,
      idleMs: 10,
      maxMs: 40,
      waitMs: 25,
    });
    openClients.push(client);
    const startPromise = binding.start(client);
    if (autoStart) await startPromise;

    const grid = (tabId = "s1") => Sap.grid(root.querySelector(`section[data-id="${tabId}"] table[grid]`));
    const cell = (r, c, tabId = "s1") =>
      root.querySelector(`section[data-id="${tabId}"] table[grid]`).querySelectorAll("tbody tr")[r].children[c];
    const tabs = () =>
      [...root.querySelectorAll(":scope > section[item]")].map((s) => ({
        id: s.getAttribute("data-id"),
        name: s.querySelector('[bind="name"]')?.textContent,
      }));
    const rawDispatch = (tabId = "s1") => origByGrid.get(grid(tabId)).bind(grid(tabId));
    return { root, book, binding, client, ui, notices, grid, cell, tabs, rawDispatch, startPromise };
  };

  const ana = await makeSide("ana", 10_000);
  const ben = await makeSide("ben", 20_000);

  return {
    Sap,
    codec,
    host,
    ana,
    ben,
    drifts,
    assertNoDrift() {
      document.removeEventListener("sheet:view-drift", onDrift);
      if (!allowDrift) expect(drifts).toEqual([]);
    },
  };
}

// Case 1. Plant: dispatch hook skips submit.
test("1. Ana sets B2; Ben's DOM and the file show it, with formula results and no stale", async () => {
  const { host, ana, ben, assertNoDrift } = await setupPair();
  ana.grid().set("B1", "10");
  await ana.client.flush();
  await until(() => ben.cell(0, 1).textContent === "10");

  expect(ben.cell(0, 2).textContent).toBe("11");
  const saved = host.file("doc").bytes;
  expect(saved).not.toMatch(/<table grid[^>]*stale/);
  expect(saved).toContain(">11<");
  assertNoDrift();
});

// Case 2. Plant: reconcile skipped.
test("2. Both set B2 before either is admitted: both DOMs converge to the room's order", async () => {
  const { host, ana, ben, assertNoDrift } = await setupPair();
  ana.grid().set("B2", "70");
  ben.grid().set("B2", "80");
  await Promise.all([ana.client.flush(), ben.client.flush()]);
  await until(() => ana.cell(1, 1).textContent === ben.cell(1, 1).textContent && ["70", "80"].includes(ana.cell(1, 1).textContent));

  expect(ana.cell(1, 1).textContent).toBe(ben.cell(1, 1).textContent);
  expect(host.file("doc").bytes).toContain(`>${ana.cell(1, 1).textContent}<`);
  assertNoDrift();
});

// Case 3. Plant: submit without Sap.grid.bound.
test("3. Ana's pending =A1+B1 meets Ben's row insert above: both show =A2+B2", async () => {
  const { host, ana, ben, assertNoDrift } = await setupPair();
  // Hold Ana's frame POST so Ben's row insert is admitted first.
  const isFrame = (req) => req.method === "POST" && req.url.includes("/_/sync/room") && !req.url.includes("op=");
  host.fault("drop", isFrame);
  ana.grid().set("C2", "=A1+B1");
  ben.grid().insertRows(1, 1);
  await ben.client.flush();
  await ana.client.flush();
  await until(() => ana.grid().cell("C3")?.content?.f === "=A2+B2" && ben.grid().cell("C3")?.content?.f === "=A2+B2");

  expect(ana.grid().cell("C3").content.f).toBe("=A2+B2");
  expect(ben.grid().cell("C3").content.f).toBe("=A2+B2");
  assertNoDrift();
});

// Case 4. Plant: reconcile ignores tab names.
test("4. Both add a tab named Q1: the second becomes Q1 (2) everywhere", async () => {
  const { ana, ben, assertNoDrift } = await setupPair();
  const html = '<table grid><colgroup><col data-id="cx" data-pos="V"></colgroup>\n<tbody>\n<tr data-id="rx" data-pos="V"></tr>\n</tbody></table>';
  ana.grid().dispatch({ v: 1, t: "insertSheet", sheet: { id: "s_ana", name: "Q1", pos: "l", html } });
  ben.grid().dispatch({ v: 1, t: "insertSheet", sheet: { id: "s_ben", name: "Q1", pos: "t", html } });
  await Promise.all([ana.client.flush(), ben.client.flush()]);
  await until(() => ana.tabs().length === 3 && ben.tabs().length === 3);

  const anaNames = ana.tabs().map((t) => t.name).sort();
  const benNames = ben.tabs().map((t) => t.name).sort();
  expect(anaNames).toEqual(["Q1", "Q1 (2)", "Sheet1"]);
  expect(benNames).toEqual(["Q1", "Q1 (2)", "Sheet1"]);
  assertNoDrift();
});

// Case 5. Plant: undo replays DOM inverse without guarded probe.
test("5. Ana sets B2, Ben changes B2, Ana undoes: Ben's value stays, notice names B2, redo empty", async () => {
  const { ana, ben, assertNoDrift } = await setupPair();
  ana.grid().set("B2", "7");
  await ana.client.flush();
  await until(() => ben.cell(1, 1).textContent === "7");
  ben.grid().set("B2", "9");
  await ben.client.flush();
  await until(() => ana.cell(1, 1).textContent === "9");

  const res = ana.binding.undo("s1");
  expect(res.ok).toBe(false);
  expect(res.why).toBe("changed");
  expect(ana.cell(1, 1).textContent).toBe("9");
  expect(ana.notices.at(-1)).toContain("Sheet1!B2");
  expect(ana.binding.canRedo("s1")).toBe(false);
  assertNoDrift();
});

// Case 6. Plant: redo rebuilt from original action instead of probe inverse.
test("6. Ana sets A1, Ben inserts a row above, Ana undoes then redoes on the moved row", async () => {
  const { ana, ben, assertNoDrift } = await setupPair();
  ana.grid().set("A1", "77");
  await ana.client.flush();
  await until(() => ben.cell(0, 0).textContent === "77");
  ben.grid().insertRows(1, 1);
  await ben.client.flush();
  await until(() => ana.cell(1, 0).textContent === "77");

  expect(ana.binding.undo("s1").ok).toBe(true);
  await ana.client.flush();
  await until(() => ben.cell(1, 0).textContent === "1");
  expect(ana.cell(1, 0).textContent).toBe("1");

  expect(ana.binding.redo("s1").ok).toBe(true);
  await ana.client.flush();
  await until(() => ben.cell(1, 0).textContent === "77");
  expect(ana.cell(1, 0).textContent).toBe("77");
  assertNoDrift();
});

// Case 7. Q16: identical value still allows undo.
test("7. Ana and Ben both set B2 to 55; Ana's undo still works", async () => {
  const { ana, ben, assertNoDrift } = await setupPair();
  ana.grid().set("B2", "55");
  await ana.client.flush();
  await until(() => ben.cell(1, 1).textContent === "55");
  ben.grid().set("B2", "55");
  await ben.client.flush();
  await until(() => ana.cell(1, 1).textContent === "55");

  expect(ana.binding.undo("s1").ok).toBe(true);
  await ana.client.flush();
  await until(() => ben.cell(1, 1).textContent === "5");
  expect(ana.cell(1, 1).textContent).toBe("5");
  assertNoDrift();
});

// Case 8. Plant: serialize(save) writes live view instead of committedInner, or committed stays stale after establish.
test("8. Page save while Ana has a pending edit returns committed region byte for byte and host accepts it", async () => {
  const { host, ana, assertNoDrift } = await setupPair();
  await ana.client.flush();
  const isFrame = (req) => req.method === "POST" && req.url.includes("/_/sync/room") && !req.url.includes("op=");
  host.fault("drop", isFrame);
  ana.grid().set("B2", "999");
  // Wait for establish to run on the host so the room moves to gen 0.00000001 while B2=999 stays pending.
  await until(() => Boolean(ana.client.status.generation && ana.client.status.generation !== "0.00000000"));

  const savedBytes = ana.book.serialize({ purpose: "save" });
  expect(savedBytes).toBe(ana.binding.committedInner());
  expect(savedBytes).not.toContain(">999<");
  expect(ana.book.serialize({ purpose: "export" })).toContain(">999<");
  expect(ana.book.serialize({ purpose: "recovery" })).toContain(">999<");

  // Posting that committed region back to /_/save must be accepted (200), never 409 Conflict.
  const res = await host.fetch("/_/save?page=doc", {
    method: "POST",
    headers: { "if-match": host.file("doc").etag },
    body: savedBytes,
  });
  expect(res.status).toBe(200);
  assertNoDrift();
});

// Case 9. Plant: extras ignore quiet, or ordered-file mode fails quietCheck because pending >= 1 during save.
test("9. Non-quiet room save writes stale and keeps file's chart figure; next quiet save and ordered-file save clear stale and write DOM drawing", async () => {
  const { host, ana, ben, assertNoDrift } = await setupPair({ chart: true });
  for (const side of [ana, ben]) {
    const figure = side.root.querySelector('section[data-id="s1"] figure[chart]');
    figure.innerHTML = figure.innerHTML.replace("#3170b8", "#00aa55");
  }

  const inner = host.file("doc").bytes;
  const base = wrapPage(inner);
  // Simulate pending edit during capture by stubbing status.pending on a direct page() check,
  // then flush quiet through the real host.
  const origStatus = Object.getOwnPropertyDescriptor(ana.client, "status");
  Object.defineProperty(ana.client, "status", { configurable: true, get: () => ({ ...origStatus.get.call(ana.client), pending: 1 }) });
  const nonQuiet = ana.binding.page(inner, base);
  Object.defineProperty(ana.client, "status", origStatus);
  expect(nonQuiet).toMatch(/<table grid[^>]*stale/);
  expect(nonQuiet).toContain("#3170b8");
  expect(nonQuiet).not.toContain("#00aa55");

  ana.grid().set("A1", "10");
  await ana.client.flush();
  const quiet = host.file("doc").bytes;
  expect(quiet).not.toMatch(/<table grid[^>]*stale/);
  expect(quiet).toContain("#00aa55");
  assertNoDrift();

  // Also verify ordered-file mode (`createFileClient`): pending >= 1 during fileSave, yet saved bytes
  // must carry formula results and the updated chart drawing with no stale attribute.
  const { Sap, codec, ana: fileSide, assertNoDrift: assertNoDrift2 } = await setupPair({ chart: true, autoStart: false });
  fileSide.binding.stop();
  await fileSide.client.close();
  const fileHost = createReferenceHost({ codecs: { sheet: codec }, codec: "sheet", room: false, rooms: { limits: labLimits() } });
  fileHost.put("fdoc", INITIAL_INNER({ chart: true }));
  const { createRoomBinding } = await import("../../../src/sheet/room.js");
  const fileBinding = createRoomBinding(fileSide.book, { Sap, quietMs: 0 });
  openBindings.push(fileBinding);
  const fetchFilePage = async (url, init = {}) => {
    if ((init.method ?? "GET").toUpperCase() === "POST" && url.includes("/_/save")) {
      const b = wrapPage(fileHost.file("fdoc").bytes);
      const full = fileBinding.page(String(init.body ?? ""), b);
      return fileHost.fetch(url, { ...init, body: findRegion(full).inner });
    }
    return fileHost.fetch(url, init);
  };
  const fileClient = await connect({
    page: "fdoc",
    codec,
    clientId: "file-ana",
    fetch: fetchFilePage,
    subscribe: fileHost.subscribe,
    extensions: ["ordered-file"],
    limits: labLimits(),
    idleMs: 10,
    maxMs: 40,
  });
  openClients.push(fileClient);
  const g = fileSide.grid();
  g.dispatch = fileBinding.dispatchFor(g, fileSide.rawDispatch());
  await fileBinding.start(fileClient);
  const fig2 = fileSide.root.querySelector('section[data-id="s1"] figure[chart]');
  fig2.innerHTML = fig2.innerHTML.replace("#3170b8", "#00aa55");
  g.set("A1", "10");
  await fileClient.flush();
  const fileSaved = fileHost.file("fdoc").bytes;
  expect(fileSaved).not.toMatch(/<table grid[^>]*stale/);
  expect(fileSaved).toContain(">12<");
  expect(fileSaved).toContain("#00aa55");
  assertNoDrift2();
});

// Case 10. Plant: quietCheck always passes.
test("10. Cell written around the room is found by quietCheck, repaired, and fires one drift event", async () => {
  const { ana, drifts, assertNoDrift } = await setupPair({ allowDrift: true });
  ana.rawDispatch()({ v: 1, t: "set", sheet: "s1", cells: [["r1", "c1", 99]] });
  expect(ana.cell(0, 0).textContent).toBe("99");

  expect(ana.binding.quietCheck()).toBe(false);
  expect(ana.cell(0, 0).textContent).toBe("1");
  expect(drifts).toHaveLength(1);
  expect(ana.binding.quietCheck()).toBe(true);
  assertNoDrift();
});

// Case 11. Plant: drop room return in workbook onChange.
test("11. No change moves book.revision in a room", async () => {
  const { ana, ben, assertNoDrift } = await setupPair();
  ana.grid().set("A2", "44");
  ben.grid().set("B2", "55");
  await Promise.all([ana.client.flush(), ben.client.flush()]);
  await until(() => ana.cell(1, 1).textContent === "55" && ben.cell(1, 0).textContent === "44");

  expect(ana.book.revision).toBe(0);
  expect(ben.book.revision).toBe(0);
  assertNoDrift();
});

// Case 12. Plant: rules left out of reconcile.
test("12. Ana adds a checkbox rule; Ben inserts a column inside it; both match; Ana's undo is skipped and named", async () => {
  const { ana, ben, assertNoDrift } = await setupPair();
  ana.grid().dispatch({
    v: 1,
    t: "rules",
    sheet: "s1",
    set: [{ id: "k_chk", pos: "V", kind: "check", range: "A1:B2" }],
    remove: [],
  });
  await ana.client.flush();
  await until(() => ben.grid().rules().some((r) => r.id === "k_chk"));

  ben.grid().insertCols("B", 1);
  await ben.client.flush();
  await until(() => ana.grid().rules().find((r) => r.id === "k_chk")?.range === "A1:C2");
  expect(ben.grid().rules().find((r) => r.id === "k_chk").range).toBe("A1:C2");

  const res = ana.binding.undo("s1");
  expect(res.ok).toBe(false);
  expect(res.why).toBe("changed");
  expect(ana.notices.at(-1)).toContain("Checkbox");
  assertNoDrift();
});

// Case 13. Plant: join regardless of issues (covered end-to-end here on real reference host).
test("13. A page with rule_id_duplicate does not join and offers repair; after repair save it joins", async () => {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.Sap;
  delete window.sapPlugins;
  delete window.clayEditMode;
  window.clay = { ready: Promise.resolve() };
  document.head.innerHTML = "";
  const dupInner = INITIAL_INNER().replace(
    "</table>",
    '<template rules><rule data-id="k1" data-pos="V" kind="check" range="A1"></rule><rule data-id="k1" data-pos="l" kind="check" range="B1"></rule></template></table>',
  );
  document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>${dupInner}</div></main>`;

  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;

  let host = null;
  let joinCalls = 0;
  window.clay.save = async () => {
    const root = document.querySelector("[sheet-workbook]");
    const codec = Sap.grid.roomCodec;
    useCodec(codec);
    host ??= createReferenceHost({ codecs: { sheet: codec }, codec: "sheet", rooms: { limits: labLimits() } });
    host.put("doc", sheet.books.get(root).serialize({ purpose: "recovery" }));
    return { msg: "Saved", msgType: "saved" };
  };
  window.clay.liveRoom = (_name, { codec: c }) => {
    joinCalls += 1;
    useCodec(c);
    host ??= createReferenceHost({ codecs: { sheet: c }, codec: "sheet", rooms: { limits: labLimits() } });
    const client = createRoomClient({
      page: "doc",
      codec: c,
      clientId: "ana",
      fetch: host.fetch,
      subscribe: host.subscribe,
      limits: labLimits(),
      idleMs: 10,
      maxMs: 40,
      waitMs: 25,
    });
    openClients.push(client);
    return client;
  };

  const { sheet, ready } = await import("../../../src/sheet/sheet.js");
  await ready;
  Sap.mount();
  await turn();
  await turn();
  await turn();

  expect(joinCalls).toBe(0);
  const inst = sheet.ui.of(document.querySelector("[sheet-workbook]"));
  expect(inst.chrome.noticeBar.textContent).toContain("Repair this sheet to edit it with others.");

  inst.chrome.topShadow.querySelector("[data-sheet-notice-action]").click();
  await until(() => Boolean(sheet.room));
  expect(joinCalls).toBe(1);
});

// Case 14. Plant: pre-ready queue dropped.
test("14. Ana's edit before ready is in her DOM at once and in the file after join, also when Ben saved first", async () => {
  const { host, ana, ben, assertNoDrift } = await setupPair({ autoStart: false });
  await ben.startPromise;
  ben.grid().set("A2", "40");
  await ben.client.flush();

  // Ana edits while still joining (before ana.startPromise resolves).
  ana.grid().set("B2", "50");
  expect(ana.cell(1, 1).textContent).toBe("50");

  await ana.startPromise;
  await ana.client.flush();
  await until(() => ben.cell(1, 1).textContent === "50" && ana.cell(1, 0).textContent === "40");

  expect(host.file("doc").bytes).toContain(">40<");
  expect(host.file("doc").bytes).toContain(">50<");
  assertNoDrift();
});

// Case 15. Plant: no batch (grouped multi-step paste sends multiple actions).
test("15. One paste of A1:C3 is one room action, and one undo takes it back on both sides", async () => {
  const { ana, ben, assertNoDrift } = await setupPair();
  const submitSpy = jest.spyOn(ana.client, "submit");
  ana.binding.group("s1", () => {
    ana.grid().setRange("A1", [
      ["10", "20", "30"],
      ["40", "50", "60"],
    ]);
    ana.grid().setRange("A3", [["70", "80", "90"]]);
  });
  await ana.client.flush();
  expect(submitSpy).toHaveBeenCalledTimes(1);
  expect(submitSpy.mock.calls[0][0].t).toBe("batch");
  await until(() => ben.cell(2, 2).textContent === "90");

  expect(ana.binding.undo("s1").ok).toBe(true);
  await ana.client.flush();
  await until(() => ben.grid().cell("C3").content === null);
  expect(ben.cell(0, 0).textContent).toBe("1");
  expect(ben.cell(1, 1).textContent).toBe("5");
  assertNoDrift();
});

// Case 16. Plant: onForeignChange closes open rule panel on any peer cell edit.
test("16. Peer plain edit outside Ana's open rule panel leaves it open; peer row insert closes it", async () => {
  const { ana, ben, assertNoDrift } = await setupPair({ mountUI: true });
  const inst = ana.ui.of(ana.root);
  const panelStillOpen = () => Boolean(inst.chrome.topShadow.querySelector("[data-conditional-panel]"));
  // Open the conditional format panel on A1.
  inst.chrome.topShadow.querySelector('[data-command="conditional-format"]').click();
  await until(panelStillOpen);

  // Ben edits C2 (outside Ana's A1 selection): panel must stay open.
  ben.grid().set("C2", "88");
  await ben.client.flush();
  await until(() => ana.cell(1, 2).textContent === "88");
  expect(panelStillOpen()).toBe(true);

  // Ben inserts a row: structural change closes the panel.
  ben.grid().insertRows(1, 1);
  await ben.client.flush();
  await until(() => ana.root.querySelectorAll('section[data-id="s1"] tbody tr').length === 4);
  expect(panelStillOpen()).toBe(false);
  assertNoDrift();
});

// Case 17. Plant: transient 5xx on first GET permanently leaves room instead of retrying and joining.
test("17. A transient failed GET on join recovers and joins the room without unbinding", async () => {
  const { Sap, codec, host, ana, ben, assertNoDrift } = await setupPair({ autoStart: false });
  await ben.startPromise;
  ana.binding.stop();
  await ana.client.close();

  const { createRoomBinding } = await import("../../../src/sheet/room.js");
  const binding = createRoomBinding(ana.book, { Sap, quietMs: 0 });
  openBindings.push(binding);
  const g = ana.grid();
  g.dispatch = binding.dispatchFor(g, ana.rawDispatch());
  let failedOnce = false;
  const flakyFetch = async (url, init) => {
    if (!failedOnce && url.includes("/_/file")) {
      failedOnce = true;
      return new Response("upstream error", { status: 503 });
    }
    return host.fetch(url, init);
  };
  const client = createRoomClient({
    page: "doc",
    codec,
    clientId: "ana-flaky",
    fetch: flakyFetch,
    subscribe: host.subscribe,
    limits: labLimits(),
    firstId: 30_000,
    idleMs: 10,
    maxMs: 40,
    waitMs: 25,
  });
  openClients.push(client);
  await binding.start(client);
  // Still bound while retrying after the single 503.
  expect(ana.book.room).toBe(binding);
  await until(() => binding.isReady());

  ben.grid().set("B2", "88");
  await ben.client.flush();
  await until(() => ana.cell(1, 1).textContent === "88");
  expect(ana.book.revision).toBe(0);
  assertNoDrift();
});

// Case 18. Plant: outside corruption while joined stays bound, or pre-ready tab insert is deleted on ready.
test("18. Pre-ready tab insert stays mounted on ready, and outside corruption while joined unbinds and closes", async () => {
  const { host, ana, ben, assertNoDrift } = await setupPair({ autoStart: false });
  await ben.startPromise;
  const html = '<table grid><colgroup><col data-id="cx" data-pos="V"></colgroup>\n<tbody>\n<tr data-id="rx" data-pos="V"></tr>\n</tbody></table>';
  ana.grid().dispatch({ v: 1, t: "insertSheet", sheet: { id: "s_new", name: "Draft", pos: "l", html } });
  const syncSpy = jest.spyOn(ana.book, "syncTabs");
  await ana.startPromise;
  expect(syncSpy).not.toHaveBeenCalled();
  expect(ana.tabs().map((t) => t.id)).toContain("s_new");
  await ana.client.flush();
  await until(() => ben.tabs().map((t) => t.id).includes("s_new"));

  // Corrupt the file on disk outside the room while joined: on the next read, binding must unbind and close.
  host.put("doc", '<section item data-id="s1" data-pos="V"><p>corrupted outside</p></section>');
  ana.client.flush().catch(() => {});
  await until(() => ana.book.room === null);
  expect(ana.client.status.connected).toBe(false);
  assertNoDrift();
});

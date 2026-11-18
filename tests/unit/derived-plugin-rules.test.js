import { jest } from "@jest/globals";

/**
 * A sapjs plugin's ownership rules (sap-ownership.vendor.js) name values the plugin
 * paints. ClayJS asks two questions of them (lib/derived.js):
 *
 *   - "Is this value an edit?" Never, whether or not the plugin runs in this tab. The
 *     dirty check, undo, the mutation hub and paint signatures ask this one, so a
 *     plugin that installs after the baseline and repaints does not make the page
 *     dirty, and a signature taken before the install still matches one taken after.
 *   - "If a merge leaves it out, will something in this tab paint it again?" Only
 *     while the plugin is installed here. A merge into a tab with the engine and no
 *     plugin takes the sender's output as content; with the plugin, it keeps its own
 *     and repaints it.
 *
 * No first party plugin has rules yet, so the cases bring `tally`, whose definition
 * says it paints the total's text and its data-sum attribute. ClayJS reads a
 * definition's rules from window.sapPlugins. tally requires `tally-base`, whose
 * download never arrives until a case installs it by hand: until then tally is
 * published but not installed, the engine stays out of its list, and its rules are on
 * the page. That is the state of a tab whose plugin is still downloading.
 *
 * The real core runs here (src/vendor/sap-core.vendor.js) on the real hub. Every case
 * loads fresh modules, because an installed plugin cannot be taken out again. Only the
 * two merge cases load live sync: it fetches its edit half after a timer, and a merge
 * waits for that half, while a case that never merges would end with it on its way.
 */

const tallyBase = { name: "tally-base", version: "1.0.0", api: 1, setup: () => ({}) };

const tally = {
  name: "tally",
  version: "1.0.0",
  api: 1,
  order: 5,
  requires: ["tally-base"],
  boundaries: { tally: { opaque: true } },
  ownership: [{ within: "[tally]", select: "li[total]", text: true, attrs: ["data-sum"] }],
  setup() {
    return {
      boundaries: {
        tally(pass, el) {
          let sum = 0;
          for (const li of el.children) {
            if (!li.hasAttribute("total")) sum += Number(li.textContent) || 0;
          }
          const total = el.querySelector("li[total]");
          if (total.textContent !== String(sum)) total.textContent = String(sum);
          if (total.getAttribute("data-sum") !== String(sum)) total.setAttribute("data-sum", String(sum));
        },
      },
    };
  },
};

const page = (a, b, total) =>
  `<main sap state="n:num" n="1"><output data-id="next" text="state.n + 1" attr:data-next="state.n + 1" data-next="2">2</output>` +
  `<ul tally="scores"><li data-id="a">${a}</li><li data-id="b">${b}</li>` +
  `<li total data-id="total" data-sum="${total}">${total}</li></ul></main>`;

class FakeEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
  }
  close() {}
}

let Sap;
let lib;
let save;
let snapshot;
let gate;
let LiveSync;
let saves;

const totalEl = () => document.querySelector("li[total]");
const shown = () => ({ text: totalEl().textContent, sum: totalEl().getAttribute("data-sum") });
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

// Fresh modules, the engine with tally published and, when `install` is set, installed,
// then the page mounted by hand and the boot baseline settled on the painted page.
async function load(body, { install = false, autosave = false, sync = false } = {}) {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.clay;
  delete window.Sap;
  delete window.sapPlugins;
  window.clayEditMode = true;
  window.scrollTo = () => {};
  global.EventSource = window.EventSource = FakeEventSource;
  global.fetch = jest.fn(async (url, init = {}) => {
    if (init.method === "POST" && /\/_\/save/.test(String(url))) {
      saves.push(init.body);
      return { ok: true, status: 200, statusText: "OK", headers: new Headers(), text: async () => JSON.stringify({ msg: "Saved" }) };
    }
    return { ok: false, status: 404, statusText: "Not Found", headers: new Headers(), text: async () => "", json: async () => ({}) };
  });
  if (autosave) document.documentElement.setAttribute("autosave", "");
  else document.documentElement.removeAttribute("autosave");
  document.documentElement.removeAttribute("unsaved");
  document.head.innerHTML = "";
  document.body.innerHTML = "";

  lib = await import("../../src/lib/derived.js");
  const Mutation = (await import("../../src/lib/mutation.js")).default;
  window.clay = { derived: lib.derived, Mutation };
  // The engine registers its repaint with clay.derived when it loads.
  Sap = (await import("../../src/vendor/sap-core.vendor.js")).default;
  Sap.plugins.loader = () => new Promise(() => {});
  Sap.use(tally);
  if (install) Sap.use(tallyBase);

  document.body.innerHTML = body;
  const { bootPhase } = await import("../../src/core/boot-phase.js");
  bootPhase.holdSettle = true;
  save = await import("../../src/core/save.js");
  snapshot = await import("../../src/core/snapshot.js");
  gate = await import("../../src/lib/dirty-gate.js");
  if (sync) {
    const liveSyncModule = await import("../../src/sync/live-sync.js");
    ({ LiveSync } = liveSyncModule);
    liveSyncModule.liveSync.stop();
  }
  if (autosave) await import("../../src/core/autosave.js");

  Sap.mount(document.querySelector("[sap]"));
  save.releaseBootSettle();
  await flush();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
}

// What each question answers for tally's total and for the engine's own output. Every
// "edit" answer is true in every state; the "merge" answers are what a case expects.
function answers() {
  const total = totalEl();
  const next = document.querySelector("output");
  const strip = (fn) => {
    const copy = document.querySelector("main").cloneNode(true);
    fn(copy);
    const t = copy.querySelector("li[total]");
    const n = copy.querySelector("output");
    return { total: t.textContent === "" && !t.hasAttribute("data-sum"), next: n.textContent === "" && !n.hasAttribute("data-next") };
  };
  const signature = lib.paintSignature(document.querySelector("main"));
  const editStrip = strip(lib.stripDerived);
  const mergeStrip = strip(lib.stripRepainted);
  return {
    "edit: data-sum on the total": lib.isDerivedAttr(total, "data-sum"),
    "edit: data-next on the output": lib.isDerivedAttr(next, "data-next"),
    "edit: text of the total": lib.ownsDerivedText(total),
    "edit: text of the output": lib.ownsDerivedText(next),
    "edit: a text change on the total": lib.isDerivedChange({ type: "characterData", element: total }),
    "edit: a text change on the output": lib.isDerivedChange({ type: "characterData", element: next }),
    "edit: stripped from the total": editStrip.total,
    "edit: stripped from the output": editStrip.next,
    "edit: the total in the paint signature": signature.includes("#7"),
    "edit: the output in the paint signature": signature.includes("#2"),
    "merge: data-sum on the total": lib.repaintsAttr(total, "data-sum"),
    "merge: data-next on the output": lib.repaintsAttr(next, "data-next"),
    "merge: text of the total": lib.repaintsText(total),
    "merge: text of the output": lib.repaintsText(next),
    "merge: stripped from the total": mergeStrip.total,
    "merge: stripped from the output": mergeStrip.next,
  };
}

function expected({ total, output }) {
  return {
    "edit: data-sum on the total": true,
    "edit: data-next on the output": true,
    "edit: text of the total": true,
    "edit: text of the output": true,
    "edit: a text change on the total": true,
    "edit: a text change on the output": true,
    "edit: stripped from the total": true,
    "edit: stripped from the output": true,
    "edit: the total in the paint signature": true,
    "edit: the output in the paint signature": true,
    "merge: data-sum on the total": total,
    "merge: data-next on the output": output,
    "merge: text of the total": total,
    "merge: text of the output": output,
    "merge: stripped from the total": total,
    "merge: stripped from the output": output,
  };
}

function makeSync() {
  const sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  return sync;
}

const captureFrame = () => snapshot.serializeForSync(snapshot.captureSnapshot({ flushUndo: false }));

// This tab and a sender start from one file: 3 + 4, total 7. This tab changes 3 to 13
// and has not saved. The sender changed 4 to 5, and its frame shows the total its own
// tally painted, 8.
async function mergeSendersFrame() {
  const sync = makeSync();
  sync.lastHtml = captureFrame();
  const frame = sync.lastHtml
    .replace('<li data-id="b">4</li>', '<li data-id="b">5</li>')
    .replace('data-sum="7">7</li>', 'data-sum="8">8</li>');
  expect(frame).toContain('<li data-id="b">5</li><li total="" data-id="total" data-sum="8">8</li>');

  document.querySelector('[data-id="a"]').textContent = "13";
  await flush();
  Sap.flush();
  expect(gate.pageMaybeDirty()).toBe(true);

  let report = null;
  const onApplied = (e) => { report = e.detail.report; };
  document.addEventListener("clay:sync-applied", onApplied);
  await sync._doApplyUpdate(frame, 5, null);
  document.removeEventListener("clay:sync-applied", onApplied);
  sync.stop();
  return report;
}

beforeEach(() => {
  saves = [];
  localStorage.clear();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  window.Sap?.unmount?.();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("while a plugin is not installed, its output is never an edit and a merge takes it as content", async () => {
  await load(page(3, 4, 7));
  expect(Sap.plugins.has("tally")).toBe(false);
  expect(lib.derivedActive()).toBe(true);

  expect(answers()).toEqual(expected({ total: false, output: true }));
});

test("once the plugin is installed, a merge leaves its output out because this tab paints it again", async () => {
  await load(page(3, 4, 7), { install: true });
  expect(Sap.plugins.has("tally")).toBe(true);

  expect(answers()).toEqual(expected({ total: true, output: true }));
});

test("with no engine in the tab, a merge takes every painted value as content", async () => {
  await load(page(3, 4, 7), { install: true });
  Sap.unmount();
  expect(lib.derivedActive()).toBe(false);

  expect(answers()).toEqual(expected({ total: false, output: false }));
});

test("a merge into a tab with the engine and no plugin shows the sender's plugin output", async () => {
  await load(page(3, 4, 7), { sync: true });
  expect(Sap.plugins.has("tally")).toBe(false);

  const report = await mergeSendersFrame();

  expect(document.querySelector('[data-id="a"]').textContent).toBe("13");
  expect(document.querySelector('[data-id="b"]').textContent).toBe("5");
  expect(shown()).toEqual({ text: "8", sum: "8" });
  expect(report.conflicts.length).toBe(0);
});

test("the same merge into a tab with the plugin installed shows the total it paints again itself", async () => {
  await load(page(3, 4, 7), { install: true, sync: true });
  expect(Sap.plugins.has("tally")).toBe(true);

  const report = await mergeSendersFrame();

  expect(document.querySelector('[data-id="a"]').textContent).toBe("13");
  expect(document.querySelector('[data-id="b"]').textContent).toBe("5");
  expect(shown()).toEqual({ text: "18", sum: "18" });
  expect(report.conflicts.length).toBe(0);
});

test("a plugin that installs after the baseline and repaints does not make the page dirty", async () => {
  // Saved before tally ever ran: the total still reads 0.
  await load(page(3, 4, 0));
  expect(save.baselineSettled()).toBe(true);
  expect(shown()).toEqual({ text: "0", sum: "0" });

  Sap.use(tallyBase);
  Sap.flush();
  await flush();

  expect(Sap.plugins.has("tally")).toBe(true);
  expect(shown()).toEqual({ text: "7", sum: "7" });
  expect(snapshot.captureForComparison()).toBe(save.getLastSavedContents());
  expect(snapshot.captureForDirtyCheck()).toBe(save.getLastSavedDirty());
  expect(gate.pageMaybeDirty()).toBe(false);
  expect(document.documentElement.hasAttribute("unsaved")).toBe(false);
});

test("a plugin that installs between the file's paint signature and the heal does not save a file that was already right", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load(page(3, 4, 7), { autosave: true });
  const file = save.currentPaintSignature();

  Sap.use(tallyBase);
  Sap.flush();
  await flush();
  expect(shown()).toEqual({ text: "7", sum: "7" });

  save.schedulePaintHeal(file);
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves).toEqual([]);
});

test("a plugin that installs late and repaints a stale file still heals it with one save", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load(page(3, 4, 0), { autosave: true });
  const file = save.currentPaintSignature();

  Sap.use(tallyBase);
  Sap.flush();
  await flush();
  expect(shown()).toEqual({ text: "7", sum: "7" });

  save.schedulePaintHeal(file);
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves.length).toBe(1);
  expect(saves[0]).toContain('data-sum="7">7</li>');
});

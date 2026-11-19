import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * plugins/derive.js gives the derive engine this release's sapjs plugins and holds the
 * mount phase for the ones the page asks for.
 *
 * The engine asks for a plugin by name. derive.js answers from SAP_PLUGINS, so the
 * plugin comes from this release's own files, and it passes any other name to a loader
 * the page set before it. It waits for Sap.plugins.ready() before its `ready` export
 * resolves. The loader's boot waits for that export before the mount phase, so the
 * first pass, and the boot baseline taken after it, see the page with its plugins
 * installed.
 *
 * No plugin ships yet, so the cases bring `tally`: the smallest plugin with a boundary
 * and a helper. A <ul tally="scores"> sums its <li> numbers into <li total>, and
 * tally('scores') reads the sum from any expression. The table lives inside derive.js,
 * so a case can put tally into it only once derive.js has run. The cases that need a
 * plugin still on its way while derive.js runs load the engine first and start the
 * download themselves, held open by a promise the case resolves.
 */

const tally = {
  name: "tally",
  version: "1.0.0",
  api: 1,
  order: 5,
  boundaries: { tally: { opaque: true } },
  helpers: ["tally"],
  setup() {
    const sums = new Map();
    return {
      boundaries: {
        tally(pass, el) {
          let sum = 0;
          for (const li of el.children) {
            if (!li.hasAttribute("total")) sum += Number(li.textContent) || 0;
          }
          sums.set(el.getAttribute("tally"), sum);
          const total = el.querySelector("li[total]");
          if (total.textContent !== String(sum)) total.textContent = String(sum);
        },
      },
      helpers: { tally: (name) => sums.get(name) ?? 0 },
    };
  },
};

// The file as saved before any pass: the total and the doubled total both read 0.
const PAGE = `<main sap plugins="tally"><ul tally="scores"><li>3</li><li>4</li><li total>0</li></ul><output id="double" text="tally('scores') * 2">0</output></main>`;
const PLAIN = `<main sap state="n:num" n="1"><output id="next" text="state.n + 1">0</output></main>`;

const painted = () => ({
  total: document.querySelector("li[total]").textContent,
  double: document.querySelector("#double").textContent,
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// One macrotask turn: every promise job queued before it has run.
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

// A fresh module registry and a page with no engine. clay.ready stays pending the way
// it does during a real boot, so an engine that loads does not mount on its own.
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

// The core, loaded before derive.js so a case can reach it first. derive.js imports
// the same module instance.
const loadCore = async () => (await import("../../src/vendor/sap-core.vendor.js")).default;

// The classic script a template's own <script src="…/v1/sap.js"> runs.
function loadFullSapjs() {
  new Function(readFileSync(join(process.cwd(), "entries/sap.js"), "utf8"))();
  return window.Sap;
}

// tally on its way: the engine has asked for it and the download is held open.
function tallyOnItsWay(Sap) {
  const download = deferred();
  Sap.plugins.loader = () => download.promise;
  Sap.plugins.load("tally");
  return () => download.resolve({ default: tally });
}

// Resolves when derive.js asks the engine which plugins the page still waits for.
function whenAsked(Sap) {
  const asked = deferred();
  const ready = Sap.plugins.ready;
  Sap.plugins.ready = (...args) => {
    asked.resolve();
    return ready(...args);
  };
  return asked.promise;
}

async function importDerive() {
  const derive = await import("../../src/plugins/derive.js");
  const state = { settled: false };
  // A rejection is the case's own to assert on, so this watcher does not leave one unhandled.
  derive.ready.then(() => { state.settled = true; }, () => {});
  return { derive, state };
}

// The engine logs each mount, and warns that a page saved with stale totals painted at
// mount, which is what these pages are for.
beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  jest.restoreAllMocks();
});

test("the loader derive gives the engine answers from this release's table, and a plugin it serves installs", async () => {
  page(PLAIN);
  const { derive } = await importDerive();
  await derive.ready;

  const { plugins } = window.Sap;
  expect(typeof plugins.loader).toBe("function");
  expect(plugins.loader("tally", {})).toBeUndefined();

  const module = { default: tally };
  derive.SAP_PLUGINS.tally = jest.fn(() => module);
  expect(plugins.loader("tally", {})).toBe(module);
  expect(derive.SAP_PLUGINS.tally).toHaveBeenCalledWith();
  expect(plugins.loader("chart", {})).toBeUndefined();

  // The page now asks for it, the way the next boot of that page would.
  document.body.innerHTML = PAGE;
  await plugins.ready(document);
  expect(plugins.has("tally")).toBe(true);
  window.Sap.mount();
  expect(painted()).toEqual({ total: "7", double: "14" });
  expect(document.querySelectorAll("[sap-error]")).toHaveLength(0);
});

test("a loader the page set before derive ran still answers every name this release does not carry", async () => {
  page(PLAIN);
  const Sap = await loadCore();
  const fromPage = { default: tally };
  const pageLoader = jest.fn(() => fromPage);
  Sap.plugins.loader = pageLoader;
  const { derive } = await importDerive();
  await derive.ready;

  const fromTable = { default: tally };
  derive.SAP_PLUGINS.tally = () => fromTable;
  expect(Sap.plugins.loader("tally", {})).toBe(fromTable);
  expect(Sap.plugins.loader("chart", { url: "/chart.js" })).toBe(fromPage);
  expect(pageLoader.mock.calls).toEqual([["chart", { url: "/chart.js" }]]);
});

test("a name that is only on Object.prototype is not one this release carries", async () => {
  page(PLAIN);
  const { derive } = await importDerive();
  await derive.ready;

  const { loader } = window.Sap.plugins;
  expect(["toString", "constructor", "valueOf"].map((name) => loader(name, {}))).toEqual([undefined, undefined, undefined]);
});

test("a page that asks for no plugin: derive loads the core, ready resolves, and the page mounts as before", async () => {
  page(PLAIN);
  const { derive } = await importDerive();
  await expect(derive.ready).resolves.toBeUndefined();

  expect(window.Sap.core).toBe(true);
  expect(window.Sap.plugins.status()).toEqual({ installed: [], loading: [], failed: [] });
  window.Sap.mount();
  expect(document.querySelector("#next").textContent).toBe("2");
});

test("a plugin this release does not carry and the engine cannot find: ready still resolves, and the engine names the failure", async () => {
  page(PAGE);
  // The engine is loaded first only to switch its two timed retries off.
  const Sap = await loadCore();
  Sap.plugins.retryDelays.length = 0;
  const failures = [];
  document.addEventListener("sap:plugin-failed", (event) => failures.push(event.detail.plugin), { once: true });

  const { derive } = await importDerive();
  await expect(derive.ready).resolves.toBeUndefined();

  expect(Sap.plugins.status().failed).toEqual(["tally"]);
  expect(failures).toEqual(["tally"]);
});

test("full sapjs has the page: derive loads no core, and the full engine gets the same table and the same wait", async () => {
  page("");
  const full = loadFullSapjs();
  expect(full.core).toBeUndefined();
  document.body.innerHTML = PAGE;
  const arrive = tallyOnItsWay(full);

  // With no core to import first, derive has asked the full engine by the time the
  // module has evaluated.
  const { derive, state } = await importDerive();
  const module = { default: tally };
  derive.SAP_PLUGINS.tally = () => module;
  expect(full.plugins.loader("tally", {})).toBe(module);
  await turn();
  expect(state.settled).toBe(false);

  arrive();
  await derive.ready;
  expect(window.Sap).toBe(full);
  expect(full.plugins.has("tally")).toBe(true);
  full.mount();
  expect(painted()).toEqual({ total: "7", double: "14" });
});

test("boot: clay.ready and the first pass wait for a plugin the page asks for, and the first pass paints with it", async () => {
  page(PAGE);
  window.history.replaceState({}, "", "/sheet.html");
  window.fetch = jest.fn(async () => new Response("", { status: 404 }));
  const ready = deferred();
  window.clay = { ready: ready.promise };
  const state = { ready: false };
  ready.promise.then(() => { state.ready = true; });

  const Sap = await loadCore();
  const arrive = tallyOnItsWay(Sap);
  const asked = whenAsked(Sap);
  const { boot } = await import("../../src/loader.js");
  const booted = boot(null, new URLSearchParams("exclude=richclay,source"), ready.resolve);

  await asked;
  await turn();
  expect(state.ready).toBe(false);
  expect(painted()).toEqual({ total: "0", double: "0" });

  arrive();
  await booted;
  expect(state.ready).toBe(true);
  expect(Sap.plugins.has("tally")).toBe(true);
  expect(painted()).toEqual({ total: "7", double: "14" });
  expect(document.querySelectorAll("[sap-error]")).toHaveLength(0);
});

const GRID = `<main sap plugins="grid"><table grid><tbody><tr data-id="r1"><td>{{ price }}</td></tr></tbody></table></main>`;

test("a page that asks for the grid gets it from this release before the mount", async () => {
  page(GRID);
  const { derive } = await importDerive();
  await derive.ready;

  expect(typeof window.Sap.grid).toBe("function");
  expect(typeof window.Sap.grid.tokenize).toBe("function");
  expect(window.Sap.grid.tokenize("=SUM(A1:B2)")).toContainEqual(
    expect.objectContaining({ type: "cell", col: "A", row: 1, start: 5, end: 7 }),
  );
  window.Sap.mount();
  expect(document.querySelectorAll("[sap-error]")).toHaveLength(0);
});

// Last in the file: the held download stays mocked for the rest of the module registry.
test("a grid still downloading when the engine stops waiting leaves its table alone, and takes it on arrival", async () => {
  page(GRID);
  const real = await import("../../src/vendor/sap-grid.vendor.js");
  const download = deferred();
  jest.unstable_mockModule("../../src/vendor/sap-grid.vendor.js", async () => {
    await download.promise;
    return real;
  });
  const Sap = await loadCore();
  const ready = Sap.plugins.ready;
  // The engine's own time limit, run out at once.
  Sap.plugins.ready = (root) => ready(root, 0);
  const { derive } = await importDerive();
  await derive.ready;
  expect(Sap.plugins.has("grid")).toBe(false);

  Sap.mount();
  expect(document.querySelectorAll("[sap-error]")).toHaveLength(0);

  download.resolve();
  await Sap.plugins.load("grid");
  expect(Sap.plugins.has("grid")).toBe(true);
  expect(document.querySelectorAll("[sap-error]")).toHaveLength(0);
});

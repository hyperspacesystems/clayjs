import { jest } from "@jest/globals";

import { _resetTheme, resolveTheme, theme } from "../../src/ui/theme.js";

const vendor = jest.fn(async () => null);
jest.unstable_mockModule("../../src/vendor/quickcrop.vendor.js", () => ({ default: vendor, quickcrop: vendor }));

const { createCropAdapter, quickcrop } = await import("../../src/plugins/quickcrop.js");

const file = new Blob(["x"], { type: "image/png" });

const CROP = (tokens = {}, parts = {}) => ({
  colorScheme: "light",
  tokens: { text: "#263d4e", surface: "#fefefd", ...tokens },
  parts,
});

const adapterFor = (tokens, parts) => createCropAdapter({ theme: resolveTheme(), confirmLabel: "Crop" });
const themedAdapter = (tokens = {}, parts = {}) => {
  theme(CROP(tokens, parts));
  return adapterFor();
};

const part = (el) => (el && el.getAttribute ? el.getAttribute("data-clay-part") || "" : "");

// jsdom has no layout, so the frame's metrics are injected; the frame's own parts name
// the element each read belongs to.
function installMetrics(values = {}) {
  const read = (el) => {
    if (values.throwOn && part(el).includes(values.throwOn)) throw new Error("no layout");
    if (el === document.documentElement) return values.documentWidth ?? 0;
    if (part(el).includes("crop.body")) return values.bodyWidth ?? 0;
    if (part(el).includes("crop.overlay")) return values.overlayHeight ?? 0;
    if (part(el).includes("crop.panel")) return values.panelHeight ?? 0;
    return 0;
  };
  for (const name of ["clientWidth", "clientHeight", "offsetHeight"]) {
    jest.spyOn(HTMLElement.prototype, name, "get").mockImplementation(function () { return read(this); });
  }
}

function stage() {
  const root = document.createElement("div");
  root.className = "qc-stage";
  root.append(document.createElement("img"), Object.assign(document.createElement("div"), { className: "qc-dim" }));
  const box = Object.assign(document.createElement("div"), { className: "qc-box" });
  for (const corner of ["nw", "ne", "sw", "se"]) {
    box.append(Object.assign(document.createElement("div"), { className: `qc-handle qc-${corner}` }));
  }
  root.append(box);
  return root;
}

const openRoot = () => document.querySelector("[data-clay-modal]");

beforeEach(() => {
  _resetTheme();
  delete window.clayTheme;
  delete window.clay;
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  vendor.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("fit: a themed frame measures the body's inner width and the overlay's height less the panel", () => {
  const adapter = themedAdapter({ spacing: "30px" });
  installMetrics({ bodyWidth: 800, overlayHeight: 600, panelHeight: 120 });

  const fit = adapter.fit();

  expect(fit.width).toBe(740);
  expect(fit.height).toBe(600 - 120);
});

test("fit: a larger spacing token yields a smaller measured width", () => {
  installMetrics({ bodyWidth: 800, overlayHeight: 600, panelHeight: 120 });
  const narrow = themedAdapter({ spacing: "40px" }).fit();
  const wide = themedAdapter({ spacing: "12px" }).fit();

  expect(narrow.width).toBe(800 - 80);
  expect(wide.width).toBe(800 - 24);
  expect(narrow.width).toBeLessThan(wide.width);
});

test("fit: the measurement frame is removed afterwards, even when a metric throws", () => {
  const adapter = themedAdapter({ spacing: "30px" });
  installMetrics({ bodyWidth: 800, overlayHeight: 600, panelHeight: 120 });
  adapter.fit();
  expect(openRoot()).toBeNull();
  expect(document.body.querySelectorAll("[data-clay-modal]").length).toBe(0);

  jest.restoreAllMocks();
  installMetrics({ throwOn: "crop.overlay" });
  expect(() => adapter.fit()).toThrow();
  expect(document.body.querySelectorAll("[data-clay-modal]").length).toBe(0);
});

test("fit: measuring moves no focus and takes no scroll lock", () => {
  const adapter = themedAdapter({ spacing: "30px" });
  installMetrics({ bodyWidth: 800, overlayHeight: 600, panelHeight: 120 });
  const before = document.activeElement;
  document.body.style.overflow = "auto";

  adapter.fit();

  expect(document.activeElement).toBe(before);
  expect(document.body.style.overflow).toBe("auto");
});

test("fit: no space at all still fits a single pixel", () => {
  const adapter = themedAdapter({ spacing: "30px" });
  installMetrics();

  expect(adapter.fit()).toEqual({ width: 1, height: 1 });
});

test("fit: an unthemed adapter keeps the fixed numbers and mounts nothing", () => {
  installMetrics({ documentWidth: 1440 });
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
  const append = jest.spyOn(document.body, "append");

  const fit = createCropAdapter().fit();

  expect(fit).toEqual({ width: 844 - 2 - 44, height: 900 - 90 - 200 });
  expect(append).not.toHaveBeenCalled();
  expect(document.querySelectorAll("[data-clay-modal]").length).toBe(0);
});

test("open: a themed stage takes its crop.* parts, its label and its confirm", () => {
  const adapter = themedAdapter({}, {
    "crop.selection": { base: { outline: "2px solid red" } },
    "crop.handle.ne": { base: { background: "blue" } },
  });
  const content = stage();
  const onConfirm = jest.fn();
  const onCancel = jest.fn();

  const handle = adapter.open({ content, confirmLabel: "Use", onConfirm, onCancel });
  const root = openRoot();
  const box = content.querySelector(".qc-box");
  const ne = content.querySelector(".qc-handle.qc-ne");
  const nw = content.querySelector(".qc-handle.qc-nw");

  expect(root.getAttribute("data-clay-ui")).toBe("crop");
  expect(box.getAttribute("data-clay-part")).toContain("crop.selection");
  expect(box.style.getPropertyValue("outline")).toBe("2px solid red");
  expect(box.style.getPropertyPriority("outline")).toBe("important");
  expect(ne.style.getPropertyValue("background")).toBe("blue");
  expect(ne.style.getPropertyPriority("background")).toBe("important");
  expect(nw.style.getPropertyValue("background")).toBe("");

  const confirm = [...root.querySelectorAll("button")].find((b) => b.textContent === "Use");
  expect(confirm).toBeTruthy();
  confirm.click();
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();

  handle.close();
  expect(openRoot()).toBeNull();
});

test("open: without explicit crop parts the stage keeps its own look", () => {
  const adapter = themedAdapter({ spacing: "20px" });
  const content = stage();
  const handle = adapter.open({ content, confirmLabel: "Crop", onConfirm: () => {}, onCancel: () => {} });
  const dim = content.querySelector(".qc-dim");
  const box = content.querySelector(".qc-box");

  expect(openRoot().getAttribute("data-clay-ui")).toBe("crop");
  expect(dim.style.getPropertyValue("background")).toBe("");
  expect(box.style.getPropertyValue("background")).toBe("");
  expect(box.style.getPropertyValue("outline")).toBe("");
  handle.close();
});

test("quickcrop: the measured frame carries the caller's confirm label", async () => {
  theme(CROP({ spacing: "30px" }));
  const appended = [];
  const original = document.body.append.bind(document.body);
  jest.spyOn(document.body, "append").mockImplementation((...nodes) => {
    appended.push(...nodes);
    return original(...nodes);
  });

  await quickcrop(file, { labels: { confirm: "Use" } });
  const opts = vendor.mock.calls[0][1];
  await opts.modal.fit();

  const frame = appended.find((node) => node.getAttribute && node.hasAttribute("data-clay-modal"));
  expect(frame).toBeTruthy();
  const confirm = [...frame.querySelectorAll("button")].find((b) => b.textContent === "Use");
  expect(confirm).toBeTruthy();
});

import { readFileSync } from "node:fs";
import { jest } from "@jest/globals";
import { $$ } from "../../helpers/editor-ui.js";
import * as Y from "../../../../src/vendor/yjs.vendor.js";
import { state as pmState } from "../../../../src/vendor/prosemirror.vendor.js";
import { createStore } from "../../../../src/live/store.js";
import { blockMap, keyBetween } from "../../../../src/page/model.js";
import { schema } from "../../../../src/page/schema.js";
import { project, renderModel, fragmentCleaner } from "../../../../src/page/projection.js";
import { createPageEditor, installPageFeature } from "../../../../src/page/editor.js";
import { createFeatureLoader } from "../../../../src/page/feature-loader.js";
import { FEATURES } from "../../../../src/page/features/registry.js";
import { createToolHost } from "../../../../src/page/tools.js";
import { toolBlockViews, toolViews } from "../../../../src/page/tool-views.js";
import { createYPageBinding, seedValue, blocksFromYValue, enc } from "../../../../src/page/ybind/index.js";

const { TextSelection } = pmState;

// The documented tally tool: its artifact is a real one, so the block mounts.
const ARTIFACTS = [...readFileSync(new URL("../../../../docs/page-tool.md", import.meta.url), "utf8").matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
const TALLY = ARTIFACTS[1];
const PARAGRAPH = { id: "p", text: "Hi " };
const TOOL = { id: "tally", t: "tool", attrs: { artifact: TALLY, rev: "r1" } };
// A tool that writes its own data on a schedule, as a running timer does.
const TICKER = {
  title: "Ticker",
  html: "<output>0</output>",
  css: "",
  javascript: "function mount(tool) { const out = tool.root.querySelector('output'); const show = () => { out.textContent = String(tool.state.data?.count ?? 0); }; tool.on('change', show); const tick = () => tool.schedule(() => { tool.state.add(['count'], 1); tick(); }, 10); tick(); show(); }",
  fallbackHtml: "<p>Ticker</p>",
  summary: "Ticker",
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitFor = async (check) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
};
const realLoad = (id) => FEATURES[id].load();
const toolsHandle = (value) => createStore({ name: "page.tools", value: clone(value) }).handle;

// A tab whose feature installs go through a tool host, as the page plugin's do.
const openTab = (initial, { load = realLoad, tools = {} } = {}) => {
  const store = createStore({ name: "page", value: initial });
  const binding = createYPageBinding({ store, setTimer: () => 1, clearTimer: () => {} });
  const toolStore = toolsHandle(tools);
  const host = createToolHost({ store: toolStore, mode: "edit" });
  const calls = [];
  const holder = { view: null, host };
  const features = createFeatureLoader({
    load: (id) => { calls.push(id); return load(id); },
    install: (id, mod) => installPageFeature({ view: holder.view, toolHost: holder.host }, id, mod),
    reportError: () => {},
  });
  const mount = document.body.appendChild(document.createElement("div"));
  const view = createPageEditor(mount, { doc: binding.doc(), dispatch: binding.dispatch, history: false, undo: binding.undo, redo: binding.redo, features });
  holder.view = view;
  binding.attach(view);
  cleanups.push(() => {
    if (!view.isDestroyed) view.destroy();
    mount.remove();
    host.dispose();
    binding.dispose();
    binding.ydoc.destroy();
  });
  return { store, binding, view, calls, host, toolStore };
};

const toolBlocks = (view) => {
  const found = [];
  view.state.doc.forEach((node) => { if (node.type.name === "tool") found.push(node); });
  return found;
};
const savedHtml = (view) => renderModel(project(blockMap(view.state.doc)), { fallbackOf: () => "", clean: fragmentCleaner(document) });
const typeIn = (view, pos, text) => view.dispatch(view.state.tr.insertText(text, pos));
const coords = { left: 40, right: 48, top: 100, bottom: 120 };
const slash = (view) => {
  view.coordsAtPos = () => coords;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.doc.content.size - 1)));
  const { from, to } = view.state.selection;
  view.someProp("handleTextInput", (handler) => handler(view, from, to, "/", () => view.state.tr.insertText("/", from, to)));
  return view.dom.parentElement.querySelector(".page-menu");
};
const toolNode = (id, pos, artifact = TALLY) => schema.nodes.tool.create({ id, pos, artifact, rev: "r1" });
const addTool = (tab, id, artifact = TALLY) => {
  const doc = tab.view.state.doc;
  const pos = keyBetween(doc.child(doc.childCount - 1).attrs.pos, null);
  tab.view.dispatch(tab.view.state.tr.insert(doc.content.size, toolNode(id, pos, artifact)));
};
const send = (from, to, key) => {
  const value = enc(Y.encodeStateAsUpdateV2(from.binding.ydoc, Y.encodeStateVector(to.binding.ydoc)));
  const base = to.store.authoritative;
  to.store.rebase({ ...base, y: { ...base.y, [key]: value } }, { source: "remote", frame: { ops: [{ op: "set", path: ["y", key], value }] } });
};

test("a text-only document's editor boots without opening or loading the tool", async () => {
  const { view, calls } = openTab(seedValue([PARAGRAPH]));
  expect(calls).toEqual([]);
  await flush();
  expect(calls).toEqual([]);
  expect(view.dom.querySelector(".page-tool-block")).toBe(null);
  expect(view.dom.querySelector('section[data-type="tool"]')).toBe(null);
});

test("opening the slash menu loads nothing", async () => {
  const { view, calls } = openTab(seedValue([PARAGRAPH]));
  const menu = slash(view);
  expect(menu.hidden).toBe(false);
  await flush();
  expect(calls).toEqual([]);
});

test("a document with a tool boots with the tool view part loaded and mounts from its state", async () => {
  const { view, calls } = openTab(seedValue([PARAGRAPH, TOOL]), { tools: { tally: { r1: { count: 3 } } } });
  expect(calls).toEqual(["tool"]);
  expect(view.dom.querySelector(".page-tool-block")).toBe(null);
  expect(await waitFor(() => view.dom.querySelector(".page-tool-block"))).toBe(true);
  expect(view.dom.querySelector(".page-tool-block output").textContent).toBe("3");
  expect(view.dom.querySelector(".page-tool-settings")).not.toBe(null);
});

test("a tool inserted while editing loads the view part once", async () => {
  const tab = openTab(seedValue([PARAGRAPH]), { tools: { tally: { r1: { count: 3 } } } });
  const { view, calls } = tab;
  expect(calls).toEqual([]);
  addTool(tab, "tally");
  expect(toolBlocks(view)).toHaveLength(1);
  expect(calls).toEqual(["tool"]);
  expect(await waitFor(() => view.dom.querySelector(".page-tool-block output"))).toBe(true);
  expect(calls).toEqual(["tool"]);
  expect(toolBlocks(view)).toHaveLength(1);
});

test("a tool block is suspended to its fallback and resumes from its saved data", async () => {
  const tab = openTab(seedValue([PARAGRAPH]), { tools: { ticker: { r1: { count: 0 } } } });
  addTool(tab, "ticker", TICKER);
  const output = () => tab.view.dom.querySelector(".page-tool-block output");
  expect(await waitFor(() => output() && Number(output().textContent) > 0)).toBe(true);
  const block = toolBlockViews.get(tab.view).get("ticker");
  expect(block).toBeTruthy();

  block.suspend();

  expect(output()).toBe(null);
  expect(tab.view.dom.querySelector(".page-tool-content").innerHTML).toBe(TICKER.fallbackHtml);
  const paused = tab.toolStore.data.ticker.r1.count;
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(tab.toolStore.data.ticker.r1.count).toBe(paused);

  block.resume();

  expect(await waitFor(() => output())).toBe(true);
  expect(Number(output().textContent)).toBeGreaterThanOrEqual(paused);
  expect(await waitFor(() => tab.toolStore.data.ticker.r1.count > paused)).toBe(true);
});

test("a tool that arrives from a peer opens the view part once", async () => {
  const initial = seedValue([PARAGRAPH]);
  const a = openTab(clone(initial), { tools: { tally: { r1: { count: 3 } }, other: { r2: { count: 1 } } } });
  const b = openTab(clone(initial), { tools: { tally: { r1: { count: 3 } }, other: { r2: { count: 1 } } } });
  expect(b.calls).toEqual([]);
  addTool(a, "tally");
  send(a, b, "peer-1");
  expect(b.calls).toEqual(["tool"]);
  expect(await waitFor(() => b.view.dom.querySelector(".page-tool-block output"))).toBe(true);
  expect(toolBlocks(b.view)).toHaveLength(1);
  addTool(a, "other");
  send(a, b, "peer-2");
  expect(await waitFor(() => toolBlocks(b.view).length === 2)).toBe(true);
  expect(b.calls).toEqual(["tool"]);
});

test("a failing load leaves the text editable and the tool's attributes intact", async () => {
  const { view } = openTab(seedValue([PARAGRAPH, TOOL]), { load: () => Promise.reject(new Error("no network")) });
  await flush();
  await flush();
  expect(view.dom.querySelector(".page-tool-block")).toBe(null);
  expect(view.dom.querySelector('section[data-type="tool"]')).not.toBe(null);
  expect(view.editable).toBe(true);
  expect(toolBlocks(view)).toHaveLength(1);
  expect(toolBlocks(view)[0].attrs.rev).toBe("r1");
  typeIn(view, 1, "Hello ");
  expect(view.state.doc.child(0).textContent).toBe("Hello Hi ");
});

test("destroying one editor keeps another editor\u2019s tool host working", async () => {
  const first = openTab(seedValue([PARAGRAPH]), { tools: { tally: { r1: { count: 3 } } } });
  const second = openTab(seedValue([PARAGRAPH]), { tools: { tally: { r1: { count: 3 } } } });
  addTool(first, "tally");
  addTool(second, "tally");
  expect(await waitFor(() => first.view.dom.querySelector(".page-tool-block"))).toBe(true);
  expect(await waitFor(() => second.view.dom.querySelector(".page-tool-block"))).toBe(true);
  expect(toolViews.get(first.view)).toBe(first.host);
  const changed = jest.spyOn(first.host, "tablesChanged");
  second.view.destroy();
  expect(toolViews.get(first.view)).toBe(first.host);
  typeIn(first.view, 1, "x");
  await tick();
  expect(changed).toHaveBeenCalled();
});

test("an install while composing waits for compositionend", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { view } = openTab(seedValue([PARAGRAPH, TOOL]), { load: () => gate.then(() => realLoad("tool")) });
  view.input.composing = true;
  expect(view.composing).toBe(true);
  release();
  await flush();
  await flush();
  expect(view.dom.querySelector(".page-tool-block")).toBe(null);
  view.dom.dispatchEvent(new CompositionEvent("compositionend"));
  expect(await waitFor(() => view.dom.querySelector(".page-tool-block"))).toBe(true);
});

test("selection, the undo stack and the save output are the same before and after the view part installs", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { view, binding } = openTab(seedValue([PARAGRAPH, TOOL]), { load: () => gate.then(() => realLoad("tool")) });
  typeIn(view, 4, "!");
  const snap = () => ({
    selection: { from: view.state.selection.from, to: view.state.selection.to },
    saved: savedHtml(view),
  });
  const before = snap();
  release();
  expect(await waitFor(() => view.dom.querySelector(".page-tool-block"))).toBe(true);
  expect(snap()).toEqual(before);
  expect(binding.undo()).toBe(true);
  await flush();
  expect(view.state.doc.child(0).textContent).toBe("Hi ");
});

test("after relaying both ways, two peers have the same projection", async () => {
  const initial = seedValue([PARAGRAPH]);
  const a = openTab(clone(initial), { tools: { tally: { r1: { count: 3 } } } });
  const b = openTab(clone(initial), { tools: { tally: { r1: { count: 3 } } } });
  addTool(a, "tally");
  send(a, b, "peer-1");
  await waitFor(() => b.view.dom.querySelector(".page-tool-block"));
  b.view.dispatch(b.view.state.tr.insertText("!", 2));
  addTool(b, "other");
  send(b, a, "peer-2");
  await flush();
  expect(blocksFromYValue(a.store.value)).toEqual(blocksFromYValue(b.store.value));
  expect(renderModel(project(blocksFromYValue(a.store.value)))).toBe(renderModel(project(blocksFromYValue(b.store.value))));
  expect(schema.nodes.tool).toBeTruthy();
});

// The page plugin: the store a tool keeps its state in opens with the tool, and
// only then; the saved tag does not depend on the view part having loaded.

let extensions = ["page"];
// The per-document helper list a host offers this caller; `/ai` needs page-tool in it,
// and the old `page-tool/1` extension alone is not enough.
let helpers = null;
await jest.unstable_mockModule("../../../../src/core/host-meta.js", () => ({
  hostMeta: async () => ({ spec: 1, extensions, document: helpers ? { helpers } : null }),
  hostSupports: async (name) => extensions.includes(name),
  hostMetaOutcome: () => "ok",
  querySaveOutcome: () => null,
  resetHostMeta: () => {},
}));

await jest.unstable_mockModule("../../../../src/core/save.js", () => ({
  savesAdmitted: () => true,
  savePageForce: async () => ({ ok: true, msgType: "success" }),
  savePage: async () => ({ ok: true, msgType: "success" }),
  savePageThrottled: () => {},
  baselineSettled: () => true,
  isSaveConflicted: () => false,
  autosaveIsSuspended: () => false,
  suspendAutosave: () => {},
  resumeAutosave: () => {},
  holdAllSaves: () => {},
  releaseAllSaves: () => {},
  getLastSavedDirty: () => false,
  setLastSavedBaselines: () => {},
  getLastSavedBytes: () => null,
}));

await jest.unstable_mockModule("../../../../src/live/local-lane.js", () => ({
  localLaneSupported: () => false,
  localTransport: () => ({}),
}));

window.clayEditMode = true;

const { live, storeOf } = await import("../../../../src/plugins/live.js");
window.clay = { live };
const { page } = await import("../../../../src/plugins/page.js");
const snapshot = await import("../../../../src/core/snapshot.js");
const projection = await import("../../../../src/page/save-projection.js");

const tagHtml = (value) => `<script type="application/json" merge="page" clay="live">${JSON.stringify(value)}</script>`;
const toolsHtml = (value) => `<script type="application/json" merge="page.tools" clay="live">${JSON.stringify(value)}</script>`;
const articleHtml = (value) => {
  const { html, rev } = projection.renderFromTags([JSON.stringify(value)]);
  return `<article data-page="1" data-rev="${rev}">${html}</article>`;
};
function setPage(blocks) {
  const value = seedValue(blocks.map(clone));
  document.head.innerHTML = tagHtml(value);
  document.body.innerHTML = articleHtml(value);
  if (!storeOf("page")) live("page");
  const store = storeOf("page");
  live("page").update((data) => {
    for (const key of Object.keys(data)) delete data[key];
    Object.assign(data, clone(value));
  });
  store.confirm(store.mark);
  return value;
}
const toolsTag = () => document.querySelector('script[merge="page.tools"]');
const setTools = (value) => {
  document.head.insertAdjacentHTML("beforeend", toolsHtml(value));
  if (storeOf("page.tools")) {
    live("page.tools").update((data) => {
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data, clone(value));
    });
  }
};

const liveCalls = [];
const recordLive = () => {
  const real = window.clay.live;
  window.clay.live = (name) => { liveCalls.push(name); return real(name); };
  cleanups.push(() => { window.clay.live = real; });
};
const opened = (name) => liveCalls.filter((call) => call === name).length;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  page.dispose();
  extensions = ["page"];
  helpers = null;
  delete window.clay.aiEdit;
  delete window.clay.wire;
  liveCalls.length = 0;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

// A writer tab over the same page, whose tool block reaches this tab as a peer's.
const openPeer = (value) => {
  const store = createStore({ name: "page", value: clone(value) });
  const binding = createYPageBinding({ store, setTimer: () => 1, clearTimer: () => {} });
  const mounted = { ensure: () => Promise.resolve(), has: () => true, dispose() {} };
  const mount = document.body.appendChild(document.createElement("div"));
  const view = createPageEditor(mount, { doc: binding.doc(), dispatch: binding.dispatch, history: false, undo: binding.undo, redo: binding.redo, features: mounted });
  binding.attach(view);
  cleanups.push(() => {
    if (!view.isDestroyed) view.destroy();
    mount.remove();
    binding.dispose();
    binding.ydoc.destroy();
  });
  return {
    insertTool(id) {
      const doc = view.state.doc;
      const pos = keyBetween(doc.child(doc.childCount - 1).attrs.pos, null);
      view.dispatch(view.state.tr.insert(doc.content.size, schema.nodes.tool.create({ id, pos, artifact: TALLY, rev: "r1" })));
      const update = enc(Y.encodeStateAsUpdateV2(binding.ydoc));
      const page_ = storeOf("page");
      const base = page_.authoritative;
      page_.rebase({ ...base, y: { ...base.y, [`peer-${id}`]: update } }, { source: "remote", frame: { ops: [{ op: "set", path: ["y", `peer-${id}`], value: update }] } });
    },
  };
};

test("a text-only document never opens the page.tools store", async () => {
  setPage([PARAGRAPH]);
  recordLive();
  await page.install();
  expect(opened("page")).toBe(1);
  expect(opened("page.tools")).toBe(0);
  expect(toolsTag()).toBe(null);
  page.view.dispatch(page.view.state.tr.insertText("!", 3));
  await tick();
  expect(opened("page.tools")).toBe(0);
  expect(toolsTag()).toBe(null);
  expect(page.view.dom.querySelector(".page-tool-block")).toBe(null);
});

test("a document with a tool opens the page.tools store before the tool edits", async () => {
  setPage([PARAGRAPH, TOOL]);
  setTools({ tally: { r1: { count: 3 } } });
  recordLive();
  await page.install();
  expect(opened("page.tools")).toBe(1);
  const block = page.view.dom.querySelector('.page-tool-block[data-id="tally"]');
  expect(block).not.toBe(null);
  expect(block.querySelector("output").textContent).toBe("3");
  block.querySelector("button").click();
  expect(storeOf("page.tools").value.tally.r1.count).toBe(4);
  expect(block.querySelector("output").textContent).toBe("4");
});

test("a tool arriving from a peer opens the page.tools store once", async () => {
  const value = setPage([PARAGRAPH, { id: "other", t: "paragraph", text: "After" }]);
  const peer = openPeer(value);
  recordLive();
  await page.install();
  expect(opened("page.tools")).toBe(0);
  expect(toolsTag()).toBe(null);
  peer.insertTool("tally");
  expect(await waitFor(() => page.view.dom.querySelector('.page-tool-block[data-id="tally"]'))).toBe(true);
  expect(opened("page.tools")).toBe(1);
  expect(toolsTag().textContent).toBe("{}");
  peer.insertTool("second");
  expect(await waitFor(() => page.view.dom.querySelector('.page-tool-block[data-id="second"]'))).toBe(true);
  expect(opened("page.tools")).toBe(1);
});

test("the file's page.tools tag is byte-identical after a save with and without the tool feature loaded", async () => {
  const saveTag = async () => {
    setPage([PARAGRAPH, TOOL]);
    setTools({ tally: { r1: { count: 3 } } });
    await page.install();
    const { forSave } = snapshot.captureForSaveAndComparison({ flushUndo: false, emitForSync: false });
    return new DOMParser().parseFromString(forSave, "text/html").querySelector('script[merge="page.tools"]').outerHTML;
  };
  const loaded = await saveTag();
  const realLoad = FEATURES.tool.load;
  FEATURES.tool.load = () => Promise.reject(new Error("no network"));
  try {
    const unloaded = await saveTag();
    expect(unloaded).toBe(loaded);
  } finally {
    FEATURES.tool.load = realLoad;
  }
  expect(loaded).toContain('merge="page.tools"');
  expect(loaded).toContain('{"tally":{"r1":{"count":3}}}');
});

const toastWith = (text) => $$("[data-clay-toast]", "toasts").find((el) => el.textContent.includes(text));
const until = async (check, timeout = 1500) => {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return check();
};

test("a failed install recovers through Retry and then renders the tool", async () => {
  setPage([PARAGRAPH, TOOL]);
  setTools({ tally: { r1: { count: 3 } } });
  const realLoad = FEATURES.tool.load;
  let attempts = 0;
  FEATURES.tool.load = () => realLoad().then((mod) => ({
    ...mod,
    createFeature: (context) => {
      attempts += 1;
      if (attempts === 1) throw new Error("install failed");
      return mod.createFeature(context);
    },
  }));
  try {
    await page.install();
    expect(await waitFor(() => toastWith("controls could not load"))).toBe(true);
    expect(page.view.dom.querySelector(".page-tool-block")).toBe(null);
    [...toastWith("controls could not load").querySelectorAll("button")].find((button) => button.textContent === "Retry").click();
    expect(await waitFor(() => page.view.dom.querySelector(".page-tool-block output"))).toBe(true);
    expect(attempts).toBe(2);
    expect(page.view.dom.querySelector(".page-tool-block output").textContent).toBe("3");
    expect(await until(() => toastWith("controls could not load") === undefined)).toBe(true);
  } finally {
    FEATURES.tool.load = realLoad;
  }
});

test("after a load fails, selection moves and typing make no further load attempts", async () => {
  setPage([PARAGRAPH, TOOL]);
  const realLoad = FEATURES.tool.load;
  let attempts = 0;
  FEATURES.tool.load = () => { attempts += 1; return Promise.reject(new Error("no network")); };
  try {
    await page.install();
    expect(await waitFor(() => attempts >= 1)).toBe(true);
    await tick();
    const view = page.view;
    for (let i = 0; i < 10; i += 1) view.dispatch(view.state.tr.setSelection(pmState.TextSelection.create(view.state.doc, 1)));
    for (let i = 0; i < 10; i += 1) view.dispatch(view.state.tr.insertText("x", 1));
    await tick();
    expect(attempts).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("xxxxxxxxxxHi ");
  } finally {
    FEATURES.tool.load = realLoad;
  }
});

test("a hosted tool's menu offers Revise when the host advertises tool authoring", async () => {
  helpers = [{ name: "page-tool", state: "ready" }];
  setPage([PARAGRAPH, TOOL]);
  setTools({ tally: { r1: { count: 3 } } });
  await page.install();
  const settings = page.view.dom.querySelector('.page-tool-block[data-id="tally"] .page-tool-settings');
  expect(settings).not.toBe(null);
  settings.click();
  const menu = page.view.dom.parentElement.querySelector(".page-menu");
  expect(menu.hidden).toBe(false);
  expect(menu.textContent).toContain("Revise\u2026");
});

// The one shared panel is ai-edit's, so this page answers /ai the way the plugin does:
// it takes the target the page builds and drives it.
function sharedPanel() {
  const opened = [];
  window.clay.aiEdit = {
    openTarget(target) { opened.push(target); return true; },
  };
  return {
    opened,
    // What ai-edit does with a target: send the comment, take the reply, preview it,
    // and let the bar's Keep keep it.
    async generate(comment) {
      const target = opened.at(-1);
      const started = await target.start(comment);
      expect(started.status).toBe("ok");
      const handle = started.send({});
      const outcome = await handle.done;
      expect(outcome.state).toBe("done");
      expect((await target.propose(outcome.result)).status).toBe("ready");
      return target;
    },
  };
}
const toolWire = () => {
  window.clay.wire = {
    send(payload) {
      return {
        done: Promise.resolve({ state: "done", result: { requestId: payload.requestId, artifact: TALLY, state: { count: 2 } } }),
        cancel() {},
      };
    },
  };
};

test("the first Make a tool click opens the composer when ai-edit installs afterwards", async () => {
  helpers = [{ name: "page-tool", state: "ready" }];
  setPage([PARAGRAPH]);
  toolWire();
  delete window.clay.aiEdit;
  await page.install({ acceptState: async () => ({ ok: true }) });
  expect(window.clay.aiEdit).toBeUndefined();
  page.view.dom.parentElement.querySelector(".page-plus").click();
  const entry = [...page.view.dom.parentElement.querySelectorAll(".page-menu-item")].find((item) => item.textContent.includes("Make a tool with AI"));
  expect(entry).toBeTruthy();
  entry.click();
  // The page AI surface is up without ai-edit: the old code checked here and dropped
  // the click. The next click installs the plugin, and the waiting target opens it.
  expect(await waitFor(() => page.ai)).toBe(true);
  expect(window.clay.aiEdit).toBeUndefined();
  const panel = sharedPanel();
  expect(await waitFor(() => panel.opened.length === 1)).toBe(true);
  expect(panel.opened[0].label).toBe("New tool");
});

test("Keep on a first AI tool in a document with no page.tools tag saves the tool", async () => {
  helpers = [{ name: "page-tool", state: "ready" }];
  setPage([PARAGRAPH]);
  expect(toolsTag()).toBe(null);
  toolWire();
  const panel = sharedPanel();
  await page.install({ acceptState: async () => ({ ok: true }) });
  page.view.dom.parentElement.querySelector(".page-plus").click();
  const entry = [...page.view.dom.parentElement.querySelectorAll(".page-menu-item")].find((item) => item.textContent.includes("Make a tool with AI"));
  expect(entry).toBeTruthy();
  entry.click();
  expect(await waitFor(() => panel.opened.length === 1)).toBe(true);
  expect(panel.opened[0].aiTarget).toBe(true);
  expect(panel.opened[0].label).toBe("New tool");
  const target = await panel.generate("make a counter");
  expect(await target.keep()).toEqual({ status: "kept" });
  expect(await waitFor(() => page.view.dom.querySelector(".page-tool-block"))).toBe(true);
  expect(toolsTag()).not.toBe(null);
  const block = page.view.dom.querySelector(".page-tool-block");
  const node = page.view.state.doc.child(1);
  expect(node.attrs.id).toBe(block.dataset.id);
  expect(storeOf("page.tools").value[node.attrs.id][node.attrs.rev]).toEqual({ count: 2 });
});

test("text typed before the slash while the tool loads is kept, and only the slash text is removed", async () => {
  helpers = [{ name: "page-tool", state: "ready" }];
  setPage([PARAGRAPH]);
  toolWire();
  const panel = sharedPanel();
  const realLoad = FEATURES.tool.load;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  FEATURES.tool.load = () => { attempts += 1; return gate.then(() => realLoad()); };
  try {
    await page.install({ acceptState: async () => ({ ok: true }) });
    const view = page.view;
    const menu = slash(view);
    [...menu.querySelectorAll(".page-menu-item")].find((item) => item.textContent.includes("Make a tool with AI")).click();
    expect(attempts).toBe(1);
    expect(panel.opened).toHaveLength(0);
    view.dispatch(view.state.tr.insertText("AB", 1));
    release();
    expect(await waitFor(() => panel.opened.length === 1)).toBe(true);
    const target = await panel.generate("make a counter");
    expect(await target.keep()).toEqual({ status: "kept" });
    expect(await waitFor(() => view.dom.querySelector(".page-tool-block"))).toBe(true);
    expect(view.state.doc.child(0).textContent).toBe("ABHi ");
    expect(toolBlocks(view)).toHaveLength(1);
  } finally {
    release();
    FEATURES.tool.load = realLoad;
  }
});

test("a replacement that lands during the boot feature wait leaves the editor read-only", async () => {
  extensions = ["page", "live-data"];
  setPage([PARAGRAPH, TOOL]);
  setTools({ tally: { r1: { count: 3 } } });
  const realLoad = FEATURES.tool.load;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let attempts = 0;
  FEATURES.tool.load = () => { attempts += 1; return gate.then(() => realLoad()); };
  let installing = null;
  try {
    installing = page.install();
    expect(await waitFor(() => page.view && attempts === 1)).toBe(true);
    expect(page.view.editable).toBe(false);
    await tick();
    const replacement = '<!doctype html><html><head></head><body><article data-page="1" data-rev="outside"><p data-id="p">Elsewhere</p></article></body></html>';
    document.dispatchEvent(new CustomEvent("clay:sync-applied", { detail: { html: replacement } }));
    await tick();
    release();
    await installing;
    expect(page.view.editable).toBe(false);
  } finally {
    release();
    await installing?.catch(() => {});
    FEATURES.tool.load = realLoad;
  }
});

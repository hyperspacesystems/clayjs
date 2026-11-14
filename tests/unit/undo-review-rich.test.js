/**
 * @jest-environment jsdom
 */

import { jest } from "@jest/globals";
import { deserialize, serialize } from "node:v8";
import { IDBFactory } from "fake-indexeddb";

globalThis.structuredClone ??= (value) => deserialize(serialize(value));

jest.setTimeout(30000);

/**
 * One history in Edit, and it is the page's.
 *
 * On any page whose plugins include `undo` there is no opt in: typing in a rich field is a
 * page entry, one per sentence, and Cmd+Z in any editable field undoes the newest page entry
 * wherever the caret is. RichClay hands its own history to the host, so its toolbar Undo
 * takes the same route. A step that can no longer be replayed is skipped, kept as a recovery
 * copy and the same press goes on to the next older one. A page that does not load `undo`
 * is unchanged.
 */

const SLOT = "/notes.html";

const BODY = `
<ul id="rich">
  <li data-id="r1"><div editable><p>Alpha</p></div></li>
  <li data-id="r2"><div editable><p>Beta</p></div></li>
</ul>
<ul id="plain">
  <li data-id="p1"><span>Plain one</span></li>
  <li data-id="p2"><span>Plain two</span></li>
</ul>
<p id="note" contenteditable="true">Note text</p>
`;

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rest = async () => {
  await settle();
  await tick(20);
};

async function until(check, tries = 400) {
  for (let at = 0; at < tries; at++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

function clearRoot() {
  const root = document.documentElement;
  for (const name of Array.from(root.attributes, (attribute) => attribute.name)) root.removeAttribute(name);
}

function response({ ok = true, status = 200, body = "", headers = {} } = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Not Found",
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body || "{}"),
  };
}

let factory;

async function boot({ edit = true, plugins = "undo", body = BODY, recovery = false } = {}) {
  jest.resetModules();
  sessionStorage.clear();
  localStorage.clear();
  delete window.clayEditMode;
  delete window.__hyperclayEditMode;
  document.cookie = "isAdminOfCurrentResource=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.cookie = "isAdminOfCurrentResource=true; path=/";
  clearRoot();
  window.history.replaceState({}, "", edit ? `${SLOT}?editmode=true` : SLOT);
  document.head.innerHTML = "";
  document.body.innerHTML = body;
  window.fetch = async (input, options = {}) => {
    const method = (options && options.method) || "GET";
    if (method === "HEAD") return response();
    if (method === "POST") return response({ body: JSON.stringify({ msg: "Saved" }) });
    if (String(input).includes("/_/meta")) {
      return response({ body: JSON.stringify({ spec: 1, extensions: [], document: {} }) });
    }
    return response({ ok: false, status: 404 });
  };
  window.scrollTo = () => {};
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  if (recovery) {
    const module = await import("../../src/core/recovery.js");
    window.clay = { recovery: module.createRecovery({ mode: "edit", indexedDB: factory }) };
  } else {
    window.clay = {};
  }
  const params = new URLSearchParams(`plugins=${plugins}`);
  const { boot: run } = await import("../../src/loader.js");
  await new Promise((resolve) => run(null, params, resolve));
  await rest();
  booted.push(window.clay);
  return window.clay;
}

const field = (id) => document.querySelector(`[data-id="${id}"] [editable]`);
const active = (id) => field(id).getAttribute("data-richclay-active") === "true";
const labels = (clay) => clay.undo.history.map((entry) => entry.label);
const saved = (clay, id) => clay.RichClay.savedContent(field(id));

const editorOf = (clay, id) => clay.RichClay.init([field(id)])[0];

const caretIn = (node) => {
  const walker = node.ownerDocument.createTreeWalker(node, 4);
  let last = null;
  for (let at = walker.nextNode(); at; at = walker.nextNode()) if (at.data) last = at;
  const range = node.ownerDocument.createRange();
  if (last) range.setStart(last, last.data.length);
  else range.setStart(node, node.childNodes.length);
  range.collapse(true);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};

// What a person's keystrokes look like to the page: one beforeinput and one input per
// character, with the text written in between.
async function type(clay, id, text) {
  const element = field(id);
  const editor = editorOf(clay, id);
  editor.focus();
  caretIn(element);
  const win = element.ownerDocument.defaultView;
  for (const char of text) {
    element.dispatchEvent(new win.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: char }));
    editor.squire.insertPlainText(char);
    element.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
  }
  await rest();
}

async function typePlain(element, text) {
  caretIn(element);
  const last = element.lastChild;
  if (last && last.nodeType === 3) last.data += text;
  else element.appendChild(element.ownerDocument.createTextNode(text));
  element.dispatchEvent(new element.ownerDocument.defaultView.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  await rest();
}

const keydown = (element, key = "z", extra = {}) => {
  const event = new element.ownerDocument.defaultView.KeyboardEvent("keydown", {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  element.dispatchEvent(event);
  return event;
};

// Everything this file listens for on the document, taken back after each case: a page
// booted here leaves its own listeners behind, and one case must not read another's events.
const open = [];

const watch = (type) => {
  const seen = [];
  const handler = (event) => seen.push(event.detail);
  document.addEventListener(type, handler);
  open.push({ type, handler });
  return seen;
};

// A peer's write lands while the page's mutation hub is paused, as a sync frame's apply does.
const peerWrite = (clay, write) => {
  clay.Mutation.pause();
  try {
    write();
  } finally {
    clay.Mutation.resume();
  }
};

beforeEach(() => {
  factory = new IDBFactory();
});

// A real page boots once; these tests boot many times in one window, and every boot
// imports a fresh engine with its own window key listeners. Each one is stopped before
// the next boot or test, or an older session's listener takes the next Cmd+Z.
const booted = [];
const stopSession = () => { for (const clay of booted.splice(0)) clay?.undo?.stop?.(); };

afterEach(() => {
  stopSession();
  for (const { type, handler } of open.splice(0)) document.removeEventListener(type, handler);
  document.body.innerHTML = "";
  window.clay = undefined;
});


test("R1 commands mode leaves rich field typing undoable through the editor", async () => {
  const clay = await boot();
  clay.undo.setRecording("commands");
  const before = saved(clay, "r1");
  await type(clay, "r1", " added");
  clay.undo.flush();
  expect(clay.undo.history).toEqual([]);
  const press = keydown(field("r1"));
  await rest();
  console.log("COMMANDS", JSON.stringify({ before, after: saved(clay, "r1"), captured: press.defaultPrevented, ownUndo: editorOf(clay, "r1").canHistory("undo") }));
  expect(field("r1").textContent).toBe("Alpha");
});

test("R2 first rich undo with nested editor UI is synchronous and keeps redo", async () => {
  const clay = await boot({body: '<ul><li data-id="r1"><div editable><p>Alpha</p><button clay="editor-ui" contenteditable="false">Tool</button></div></li></ul>'});
  const el = field("r1");
  const editor = editorOf(clay, "r1");
  expect(el.querySelector('[clay~="editor-ui"]')).not.toBeNull();
  const before = saved(clay, "r1");
  editor.focus();
  document.getSelection().collapse(el.querySelector("p").firstChild, 5);
  el.querySelector("p").firstChild.data += " added";
  await rest();
  clay.undo.flush();
  const receipt = clay.undo.undo();
  const immediate = saved(clay, "r1");
  const immediateRedo = clay.undo.redo();
  const immediateRedoText = el.querySelector("p").textContent;
  await rest();
  console.log("EDITORUI", JSON.stringify({ before, receipt, immediate, immediateRedo, immediateRedoText, eventual: saved(clay, "r1"), history: clay.undo.history, future: clay.undo.future }));
  expect(receipt.ok).toBe(true);
  expect(immediate).toBe(before);
  expect(immediateRedo.ok).toBe(true);
  expect(immediateRedoText).toBe("Alpha added");
  expect(clay.undo.canRedo).toBe(false);
});


test.each(["editor-ui", "no-undo"])("R3 nested %s state does not become rich content history", async (marker) => {
  const clay = await boot({body: `<ul><li data-id="r1"><div editable><p>Alpha</p><button ${marker} contenteditable="false">Tool</button></div></li></ul>`});
  const el = field("r1");
  const button = el.querySelector("button");
  expect(clay.undo.history).toEqual([]);
  button.textContent = "Updated tool";
  await rest();
  clay.undo.flush();
  console.log("CHROME", marker, JSON.stringify(clay.undo.history.map(e => clay.undo.describe(e.id))));
  expect(clay.undo.history).toEqual([]);
});


test.each(["editor-ui", "no-undo"])("R3 nested %s refresh keeps the previous text available for Redo", async (marker) => {
  const clay = await boot({body: `<ul><li data-id="r1"><div editable><p>Alpha</p><button ${marker} contenteditable="false">Tool</button></div></li></ul>`});
  await (await import("../../src/sync/merge-engine.js")).mergeEngine();
  const el = field("r1");
  el.querySelector("p").firstChild.data += " added";
  await rest();
  clay.undo.flush();
  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  expect(el.querySelector("p").textContent).toBe("Alpha");
  expect(clay.undo.canRedo).toBe(true);
  el.querySelector("button").textContent = "Updated tool";
  await rest();
  clay.undo.flush();
  const redo = clay.undo.redo();
  console.log("CHROME-REDO", marker, JSON.stringify({redo, text: el.querySelector("p").textContent, history: clay.undo.history}));
  expect(el.querySelector("p").textContent).toBe("Alpha added");
});

test("R4 browser undo in a nested form input stays with the input", async () => {
  const clay = await boot({body: '<ul><li data-id="r1"><div editable><p>Alpha</p><span editor-ui contenteditable="false"><input value="tool query"></span></div></li></ul>'});
  const el = field("r1");
  await (await import("../../src/sync/merge-engine.js")).mergeEngine();
  el.querySelector("p").firstChild.data += " added";
  await rest();
  clay.undo.flush();
  const control = el.querySelector("input");
  control.focus();
  control.value = "new query";
  const event = new window.InputEvent("beforeinput", {bubbles:true, cancelable:true, inputType:"historyUndo"});
  control.dispatchEvent(event);
  await rest();
  console.log("FORM-UNDO", JSON.stringify({prevented:event.defaultPrevented, text:el.querySelector("p").textContent, input:control.value}));
  expect(el.querySelector("p").textContent).toBe("Alpha added");
  expect(event.defaultPrevented).toBe(false);
});

test("control without page history: rich editor can undo its typing", async () => {
  const clay = await boot({plugins: "richclay"});
  await type(clay, "r1", " added");
  keydown(field("r1"));
  await rest();
  expect(field("r1").textContent).toBe("Alpha");
});

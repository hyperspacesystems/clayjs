/**
 * @jest-environment jsdom
 */

import { jest } from "@jest/globals";
import { deserialize, serialize } from "node:v8";

globalThis.structuredClone ??= (value) => deserialize(serialize(value));

jest.setTimeout(30000);

/**
 * The caret after an undo or a redo.
 *
 * After a replay that changed text, the person should be able to go on typing where the
 * text changed: the field takes focus and the selection collapses at the change. When
 * focus is elsewhere (a button, the dock's Undo) the field is only scrolled into view,
 * because focusing it would open a phone's keyboard. A structural step moves neither.
 *
 * The engine's receipts are the source of the hint: `{ node, offset }` for a text run and
 * `{ root, textOffset }` for a field whose saved content is its text. Nothing here is
 * placed when no undo session is live.
 */

const SLOT = "/notes.html";

const BODY = `
<ul id="rich">
  <li data-id="r1"><div editable><p>Alpha</p></div></li>
  <li data-id="r2"><div editable><p>Beta</p></div></li>
</ul>
<ul id="plain">
  <li data-id="p1"><span>Plain one</span></li>
</ul>
<p id="note" contenteditable="true">Note text</p>
<p id="other" contenteditable="true">Other text</p>
<button id="go" type="button">Undo</button>
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

async function boot({ edit = true, plugins = "undo", body = BODY } = {}) {
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
  window.clay = {};
  const params = new URLSearchParams(`plugins=${plugins}`);
  const { boot: run } = await import("../../src/loader.js");
  await new Promise((resolve) => run(null, params, resolve));
  await rest();
  booted.push(window.clay);
  return window.clay;
}

const field = (id) => document.querySelector(`[data-id="${id}"] [editable]`);

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

const caretAt = (node, offset) => {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};

// Where the selection is, as two values that survive the text around it changing.
const anchor = () => ({ node: document.getSelection().anchorNode, offset: document.getSelection().anchorOffset });

// The caret's offset into the field's whole text, and that text's length.
function caretTextOffset(root) {
  const selection = document.getSelection();
  const walker = document.createTreeWalker(root, 4);
  let at = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === selection.anchorNode) return at + selection.anchorOffset;
    at += node.data.length;
  }
  return null;
}

function textLength(root) {
  const walker = document.createTreeWalker(root, 4);
  let at = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) at += node.data.length;
  return at;
}

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

// A peer's write lands while the page's mutation hub is paused, as a sync frame's apply does.
const peerWrite = (clay, write) => {
  clay.Mutation.pause();
  try {
    write();
  } finally {
    clay.Mutation.resume();
  }
};

// A real page boots once; these tests boot many times in one window, and every boot
// imports a fresh engine with its own window key listeners. Each one is stopped before
// the next boot or test, or an older session's listener takes the next Cmd+Z.
const booted = [];
const stopSession = () => { for (const clay of booted.splice(0)) clay?.undo?.stop?.(); };

afterEach(() => {
  stopSession();
  document.body.innerHTML = "";
  window.clay = undefined;
});

// jsdom has no scrollIntoView; the field's own scroll is what a browser does for it.
beforeEach(() => {
  if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = () => {};
});

test("undo of text typed at the end of a plain field leaves the caret at the end of what is left", async () => {
  const clay = await boot();
  const note = document.getElementById("note");
  note.focus();
  await typePlain(note, " edited");
  clay.undo.flush();

  expect(clay.undo.undo().ok).toBe(true);
  await rest();

  expect(note.textContent).toBe("Note text");
  expect(document.activeElement).toBe(note);
  const selection = document.getSelection();
  expect(selection.isCollapsed).toBe(true);
  expect(selection.anchorNode).toBe(note.firstChild);
  expect(selection.anchorOffset).toBe("Note text".length);
});

test("redo puts the caret back at the end of the retyped text", async () => {
  const clay = await boot();
  const note = document.getElementById("note");
  note.focus();
  await typePlain(note, " edited");
  clay.undo.flush();
  expect(clay.undo.undo().ok).toBe(true);
  await rest();

  expect(clay.undo.redo().ok).toBe(true);
  await rest();

  expect(note.textContent).toBe("Note text edited");
  expect(document.activeElement).toBe(note);
  const selection = document.getSelection();
  expect(selection.isCollapsed).toBe(true);
  expect(selection.anchorNode).toBe(note.firstChild);
  expect(selection.anchorOffset).toBe("Note text edited".length);
});

test("undo of a change in the middle of a plain field leaves the caret where the removed run was", async () => {
  const clay = await boot();
  const note = document.getElementById("note");
  note.focus();
  caretIn(note);
  const text = note.firstChild;
  text.data = "Note INSERTED text";
  note.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: " INSERTED" }));
  await rest();
  clay.undo.flush();

  expect(clay.undo.undo().ok).toBe(true);
  await rest();

  expect(note.textContent).toBe("Note text");
  expect(document.activeElement).toBe(note);
  const selection = document.getSelection();
  expect(selection.isCollapsed).toBe(true);
  expect(selection.anchorNode).toBe(note.firstChild);
  expect(selection.anchorOffset).toBe("Note INSERTED text".indexOf("INSERTED"));
});

test("undo of typing in a rich field puts the caret inside the field at the matching text offset", async () => {
  const clay = await boot();
  await type(clay, "r1", " and more");
  clay.undo.flush();
  expect(clay.undo.undo().ok).toBe(true);
  await rest();

  const element = field("r1");
  expect(element.textContent).toBe("Alpha");
  expect(document.activeElement).toBe(element);
  const selection = document.getSelection();
  expect(selection.isCollapsed).toBe(true);
  expect(element.contains(selection.anchorNode)).toBe(true);
  expect(caretTextOffset(element)).toBe(textLength(element));
});

test("undo of a structural step moves neither the caret nor the focus", async () => {
  const clay = await boot();
  const note = document.getElementById("note");
  note.focus();
  caretAt(note.firstChild, 4);
  const item = document.querySelector('[data-id="p1"]');
  clay.undo.commit("Remove item", () => item.remove());
  await rest();
  const before = anchor();

  expect(clay.undo.undo().ok).toBe(true);
  await rest();

  expect(item.isConnected).toBe(true);
  expect(anchor()).toEqual(before);
  expect(document.activeElement).toBe(note);
});

test("a field whose checkVisibility() answers false is not focused and not scrolled to", async () => {
  const clay = await boot();
  const note = document.getElementById("note");
  const other = document.getElementById("other");
  note.focus();
  await typePlain(note, " edited");
  clay.undo.flush();

  other.focus();
  caretAt(other.firstChild, 2);
  note.checkVisibility = () => false;
  const scrolled = jest.fn();
  note.scrollIntoView = scrolled;
  const focused = jest.fn();
  note.focus = focused;
  const before = anchor();

  expect(clay.undo.undo().ok).toBe(true);
  await rest();

  expect(focused).not.toHaveBeenCalled();
  expect(scrolled).not.toHaveBeenCalled();
  expect(anchor()).toEqual(before);
  expect(document.activeElement).toBe(other);
});

test("a field that already has focus is not focused again, and the selection still moves", async () => {
  const clay = await boot();
  const note = document.getElementById("note");
  note.focus();
  await typePlain(note, " edited");
  clay.undo.flush();
  caretAt(note.firstChild, 0);
  const focused = jest.fn();
  note.focus = focused;

  expect(clay.undo.undo().ok).toBe(true);
  await rest();

  expect(focused).not.toHaveBeenCalled();
  expect(document.getSelection().anchorNode).toBe(note.firstChild);
  expect(document.getSelection().anchorOffset).toBe("Note text".length);
});

test("after leaving Edit (no live session), a replay's receipt never changes the selection", async () => {
  const clay = await boot();
  const note = document.getElementById("note");

  const plugin = await import("../../src/plugins/undo.js");
  const lease = await plugin.undoParticipant().prepare({ generation: 2, isCurrent: () => true });
  lease.dispose();
  await rest();
  expect(clay.undo.pageHistory).toBe(false);

  // The engine is started again, on its own, with no session over the page: a receipt
  // still carries a caret, and nothing may act on it.
  lease.enable();
  await rest();
  expect(clay.undo.pageHistory).toBe(false);

  note.focus();
  await typePlain(note, " edited");
  clay.undo.flush();
  caretAt(note.firstChild, 0);
  const before = anchor();

  expect(clay.undo.undo().ok).toBe(true);
  await rest();

  expect(note.textContent).toBe("Note text");
  expect(anchor()).toEqual(before);
  expect(document.activeElement).toBe(note);
});

test("with focus on a button, undo scrolls the field into view and leaves focus and the selection alone", async () => {
  const clay = await boot();
  const note = document.getElementById("note");
  const other = document.getElementById("other");
  note.focus();
  await typePlain(note, " edited");
  clay.undo.flush();
  caretAt(other.firstChild, 2);
  document.getElementById("go").focus();
  const before = anchor();

  const scrolled = jest.fn();
  note.scrollIntoView = scrolled;
  const focused = jest.fn();
  note.focus = focused;

  expect(clay.undo.undo().ok).toBe(true);
  await rest();

  expect(scrolled).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  expect(focused).not.toHaveBeenCalled();
  expect(anchor()).toEqual(before);
  expect(document.activeElement.id).toBe("go");
});

test("undo that skipped a stale step places the caret in the entry it applied", async () => {
  const clay = await boot();
  await type(clay, "r2", " two");
  clay.undo.flush();
  await type(clay, "r1", " one");
  clay.undo.flush();

  peerWrite(clay, () => { field("r1").querySelector("p").textContent = "A peer's words"; });
  await rest();
  clay.undo.flush();

  const receipt = clay.undo.undo();
  await rest();

  expect(receipt.ok).toBe(true);
  expect(receipt.skipped).toHaveLength(1);
  expect(field("r2").textContent).toBe("Beta");
  expect(document.activeElement).toBe(field("r2"));
  expect(document.getSelection().isCollapsed).toBe(true);
  expect(caretTextOffset(field("r2"))).toBe(textLength(field("r2")));
});

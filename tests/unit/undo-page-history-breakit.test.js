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


// Break-it cases (M7). A peer's write stands in for a sync frame the same way the cases in
// undo-page-history.test.js do it: applied while the mutation hub is paused.

test("control: a peer changes a rich field after this tab's step closed: undo skips the step and keeps the peer's words", async () => {
  const clay = await boot();
  await type(clay, "r1", " one");
  clay.undo.flush();
  peerWrite(clay, () => { field("r1").insertAdjacentHTML("afterbegin", "<p>A peer's paragraph</p>"); });
  await rest();
  const skipped = watch("clay:undo-skipped");
  clay.undo.undo();
  await rest();
  expect(skipped).toHaveLength(1);
  expect(saved(clay, "r1")).toContain("A peer's paragraph");
  expect(saved(clay, "r1")).toContain("one");
});

test("BREAK: a peer changes a rich field while this tab's typing step is open: this tab's undo takes the peer's words away", async () => {
  const clay = await boot();
  await type(clay, "r1", " one");
  peerWrite(clay, () => { field("r1").insertAdjacentHTML("afterbegin", "<p>A peer's paragraph</p>"); });
  await settle();
  await type(clay, "r1", " two");
  clay.undo.flush();
  expect(saved(clay, "r1")).toContain("A peer's paragraph");

  const after = [];
  while (clay.undo.canUndo) {
    clay.undo.undo();
    await rest();
    after.push(saved(clay, "r1").includes("A peer's paragraph"));
  }
  expect(after.every(Boolean)).toBe(true);
  expect(saved(clay, "r1")).not.toContain("two");
});

test("BREAK: the same in a plain field", async () => {
  const clay = await boot();
  const note = document.getElementById("note");
  await typePlain(note, " one");
  peerWrite(clay, () => { note.firstChild.data = `A peer's words. ${note.firstChild.data}`; });
  await settle();
  await typePlain(note, " two");
  clay.undo.flush();
  expect(note.textContent).toBe("A peer's words. Note text one two");

  const after = [];
  while (clay.undo.canUndo) {
    clay.undo.undo();
    await rest();
    after.push(note.textContent);
  }
  expect(after.filter((text) => !text.includes("A peer's words."))).toEqual([]);
  expect(note.textContent).not.toContain("two");
});

test("a skipped step in a plain field is kept as a recovery copy that holds the typed words", async () => {
  const clay = await boot({ recovery: true });
  const kept = watch("clay:undo-kept");
  const note = document.getElementById("note");
  await typePlain(note, " Mine.");
  clay.undo.flush();
  peerWrite(clay, () => { note.firstChild.data = "A peer's words"; });
  await rest();
  const receipt = clay.undo.undo();
  expect(receipt.code).toBe("empty");
  expect(note.textContent).toBe("A peer's words");
  expect(await until(() => kept.length > 0)).toBe(true);
  const listed = await clay.undo.kept();
  expect(JSON.stringify(listed.records.map((record) => record.payload.steps))).toContain("Note text Mine.");
});

test("a redo that is skipped is kept as a recovery copy that holds the words redo would have put back", async () => {
  const clay = await boot({ recovery: true });
  const kept = watch("clay:undo-kept");
  const skipped = watch("clay:undo-skipped");
  await type(clay, "r1", " one");
  clay.undo.flush();
  const typed = saved(clay, "r1");
  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  expect(saved(clay, "r1")).not.toContain("one");
  peerWrite(clay, () => { field("r1").querySelector("p").textContent = "A peer's words"; });
  await rest();

  const receipt = clay.undo.redo();
  await rest();
  expect(receipt.ok).toBe(false);
  expect(skipped.map((item) => item.direction)).toEqual(["redo"]);
  expect(saved(clay, "r1")).toContain("A peer's words");
  expect(await until(() => kept.length > 0)).toBe(true);
  const listed = await clay.undo.kept();
  expect(listed.records).toHaveLength(1);
  expect(listed.records[0].payload.steps[0].after).toBe(typed);
});

test("one press that skips three stale steps keeps three recovery copies", async () => {
  const clay = await boot({ recovery: true });
  const kept = watch("clay:undo-kept");
  const skipped = watch("clay:undo-skipped");
  await type(clay, "r1", " One. Two. Three.");
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Edit", "Edit", "Edit"]);
  peerWrite(clay, () => { field("r1").insertAdjacentHTML("afterbegin", "<p>A peer's paragraph</p>"); });
  await rest();
  clay.undo.undo();
  await rest();
  expect(await until(() => kept.length >= 3)).toBe(true);
  const listed = await clay.undo.kept();
  expect({ skipped: skipped.length, copies: listed.records.length, text: saved(clay, "r1").includes("Three.") }).toEqual({ skipped: 3, copies: 3, text: true });
});

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

test("with undo loaded and Edit on, the page owns the history, and leaving Edit gives it back", async () => {
  const clay = await boot();
  expect(clay.undo.pageHistory).toBe(true);
  expect(clay.RichClay.hostHistory).toBe(true);
  expect(active("r1")).toBe(true);

  const sessions = watch("clay:undo-session");
  const plugin = await import("../../src/plugins/undo.js");
  const lease = await plugin.undoParticipant().prepare({ generation: 2, isCurrent: () => true });
  lease.dispose();
  await rest();
  expect(clay.undo.pageHistory).toBe(false);
  expect(clay.RichClay.hostHistory).toBe(false);
  expect(sessions.at(-1)).toEqual({ started: false, pageHistory: false });
});

test("typing in a rich field is one page entry, and a page without undo makes none", async () => {
  const clay = await boot();
  const authored = saved(clay, "r1");
  await type(clay, "r1", " and more");
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Edit"]);
  const described = clay.undo.describe(clay.undo.history.at(-1).id);
  expect(described.steps).toEqual([
    { kind: "value", target: { id: "r1" }, prop: "content", before: authored, after: saved(clay, "r1") },
  ]);

  const without = await boot({ plugins: "richclay" });
  expect(without.undo).toBeUndefined();
  await type(without, "r1", " and more");
  expect(without.undo).toBeUndefined();
});

test("undo puts the field's saved content back and redo the typed content", async () => {
  const clay = await boot();
  const authored = saved(clay, "r1");
  await type(clay, "r1", " and more");
  clay.undo.flush();
  const typed = saved(clay, "r1");
  expect(typed).not.toBe(authored);

  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  expect(saved(clay, "r1")).toBe(authored);

  expect(clay.undo.redo().ok).toBe(true);
  await rest();
  expect(saved(clay, "r1")).toBe(typed);
});

test("three entries undo newest first and redo in the same order", async () => {
  const clay = await boot();
  await type(clay, "r1", " and more");
  clay.undo.flush();
  const typed = saved(clay, "r1");

  const item = document.querySelector('[data-id="p1"]');
  clay.undo.commit("Remove item", () => item.remove());
  await rest();

  await typePlain(document.getElementById("note"), " edited");
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Edit", "Remove item", "Edit"]);

  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  expect(document.getElementById("note").textContent).toBe("Note text");

  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  expect(item.isConnected).toBe(true);

  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  expect(saved(clay, "r1")).not.toBe(typed);

  expect(clay.undo.redo().ok).toBe(true);
  await rest();
  expect(saved(clay, "r1")).toBe(typed);
  expect(clay.undo.redo().ok).toBe(true);
  await rest();
  expect(item.isConnected).toBe(false);
  expect(clay.undo.redo().ok).toBe(true);
  await rest();
  expect(document.getElementById("note").textContent).toBe("Note text edited");
});

test("Cmd+Z in a rich field brings back a removed item and leaves the typed text", async () => {
  const clay = await boot();
  await type(clay, "r1", " and more");
  clay.undo.flush();
  const typed = saved(clay, "r1");

  const item = document.querySelector('[data-id="p1"]');
  clay.undo.commit("Remove item", () => item.remove());
  await rest();

  keydown(field("r1"));
  await rest();
  expect(item.isConnected).toBe(true);
  expect(saved(clay, "r1")).toBe(typed);

  keydown(field("r1"));
  await rest();
  expect(saved(clay, "r1")).not.toBe(typed);
});

test("Cmd+Z in a plain contenteditable undoes the newest page entry, and on a page without undo it is not taken", async () => {
  const clay = await boot();
  await type(clay, "r1", " and more");
  clay.undo.flush();
  const typed = saved(clay, "r1");

  const note = document.getElementById("note");
  const event = keydown(note);
  await rest();
  expect(event.defaultPrevented).toBe(true);
  expect(saved(clay, "r1")).not.toBe(typed);

  stopSession();
  const without = await boot({ plugins: "richclay" });
  await type(without, "r1", " and more");
  const theirs = saved(without, "r1");
  const untreated = keydown(document.getElementById("note"));
  await rest();
  expect(untreated.defaultPrevented).toBe(false);
  expect(saved(without, "r1")).toBe(theirs);
});

test("the toolbar's Undo undoes the newest page entry", async () => {
  const clay = await boot();
  await type(clay, "r1", " and more");
  clay.undo.flush();
  const typed = saved(clay, "r1");

  editorOf(clay, "r1").history("undo");
  await rest();
  expect(saved(clay, "r1")).not.toBe(typed);
  expect(clay.undo.canRedo).toBe(true);
});

test("a rich field that arrives after the session started is tracked", async () => {
  const clay = await boot();
  const list = document.querySelector("#rich");
  const item = document.createElement("li");
  item.dataset.id = "r3";
  item.innerHTML = "<div editable><p>Gamma</p></div>";
  clay.undo.commit("Add item", () => list.append(item));
  await rest();
  expect(active("r3")).toBe(true);

  await type(clay, "r3", " typed");
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Add item", "Edit"]);

  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  expect(document.querySelector('[data-id="r3"] [editable]').textContent).toBe("Gamma");

  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  expect(item.isConnected).toBe(false);
});

test("a host write makes no entry, and the next typing starts from what was written", async () => {
  const clay = await boot();
  // A host write lands synchronously under the pause, as site-edits.js does; the page's
  // async clay.morph would land after the resume and be recorded as typing.
  const now = (root, html) => { root.innerHTML = html; };
  peerWrite(clay, () => clay.RichClay.setSavedContent(field("r1"), "Written by the host", { morph: now }));
  await rest();
  clay.undo.flush();
  expect(labels(clay)).toEqual([]);
  const written = saved(clay, "r1");
  expect(written).toContain("Written by the host");

  await type(clay, "r1", " plus");
  clay.undo.flush();
  const described = clay.undo.describe(clay.undo.history.at(-1).id);
  expect(described.steps[0].before).toBe(written);
  expect(described.steps[0].after).toBe(saved(clay, "r1"));
});

test("an authored no-undo field is not tracked, and its Cmd+Z is left alone", async () => {
  const bodiless = BODY.replace("<div editable><p>Alpha</p></div>", "<div editable no-undo><p>Alpha</p></div>");
  const clay = await boot({ body: bodiless });
  await type(clay, "r1", " and more");
  clay.undo.flush();
  expect(labels(clay)).toEqual([]);

  expect(active("r1")).toBe(true);
  keydown(field("r1"));
  await rest();
  expect(labels(clay)).toEqual([]);
  expect(clay.undo.canUndo).toBe(false);
});

test("leaving Edit and entering again tracks the fields again", async () => {
  const clay = await boot();
  const plugin = await import("../../src/plugins/undo.js");
  const richclay = await import("../../src/plugins/richclay.js");
  expect(clay.undo.pageHistory).toBe(true);

  const leaving = await plugin.undoParticipant().prepare({ generation: 2, isCurrent: () => true });
  leaving.dispose();
  await rest();
  expect(clay.undo.pageHistory).toBe(false);
  expect(clay.RichClay.hostHistory).toBe(false);

  const entering = await plugin.undoParticipant().prepare({ generation: 3, isCurrent: () => true });
  entering.enable();
  await rest();
  expect(clay.undo.pageHistory).toBe(true);
  expect(clay.RichClay.hostHistory).toBe(true);

  await type(clay, "r1", " again");
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Edit"]);
  entering.dispose();
});

test("a hold reports nothing available and refuses to change the page", async () => {
  const clay = await boot();
  await type(clay, "r1", " and more");
  clay.undo.flush();
  const typed = saved(clay, "r1");

  const changes = watch("clay:undo-change");
  const release = clay.undo.hold();
  await rest();
  expect(changes.at(-1).canUndo).toBe(false);
  expect(changes.at(-1).canRedo).toBe(false);

  expect(clay.undo.undo()).toEqual({ ok: false, code: "held" });
  await rest();
  expect(saved(clay, "r1")).toBe(typed);

  release();
  await rest();
  expect(changes.at(-1).canUndo).toBe(true);
  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  expect(saved(clay, "r1")).not.toBe(typed);
});

test("a step the page changed under is skipped, and the same press undoes the one before it", async () => {
  const clay = await boot();
  await type(clay, "r2", " two");
  clay.undo.flush();
  await type(clay, "r1", " one");
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Edit", "Edit"]);

  const newer = clay.undo.history.at(-1);
  const beta = saved(clay, "r2");
  peerWrite(clay, () => { field("r1").querySelector("p").textContent = "A peer's words"; });
  await rest();
  clay.undo.flush();

  const skipped = watch("clay:undo-skipped");
  const refusals = watch("clay:undo-refused");

  const receipt = clay.undo.undo();
  await rest();

  expect(receipt.ok).toBe(true);
  expect(skipped).toHaveLength(1);
  expect(skipped[0]).toEqual({ entryId: newer.id, label: "Edit", direction: "undo", code: "content-changed" });
  expect(refusals).toEqual([]);
  expect(saved(clay, "r2")).not.toBe(beta);
  expect(saved(clay, "r1")).toContain("A peer's words");
  expect(clay.undo.describe(newer.id)).toBeNull();
  expect(clay.undo.canRedo).toBe(true);
});

test("a skipped step is kept as a recovery copy", async () => {
  const clay = await boot({ recovery: true });
  const kept = watch("clay:undo-kept");
  const authored = saved(clay, "r1");
  await type(clay, "r1", " one");
  clay.undo.flush();
  const typed = saved(clay, "r1");
  const skippedEntry = clay.undo.history.at(-1);
  peerWrite(clay, () => { field("r1").querySelector("p").textContent = "A peer's words"; });
  await rest();
  clay.undo.flush();

  const receipt = clay.undo.undo();
  expect(receipt.ok).toBe(false);
  expect(receipt.code).toBe("empty");

  expect(await until(() => kept.length > 0)).toBe(true);
  expect(kept.at(-1)).toEqual({ ok: true, entryId: skippedEntry.id, direction: "undo" });

  const listed = await clay.undo.kept();
  expect(listed.ok).toBe(true);
  expect(listed.records[0].payload.label).toBe("Edit");
  expect(listed.records[0].payload.code).toBe("content-changed");
  expect(listed.records[0].payload.steps).toEqual([
    { kind: "value", target: { id: "r1" }, prop: "content", before: authored, after: typed },
  ]);
});

test("two sentences typed without pausing undo in two presses", async () => {
  const clay = await boot();
  const authored = saved(clay, "r1");
  await type(clay, "r1", "One. Two.");
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Edit", "Edit"]);
  const both = saved(clay, "r1");
  expect(both).not.toBe(authored);
  const [first, second] = clay.undo.history;
  expect(clay.undo.describe(first.id).steps[0].before).toBe(authored);
  expect(clay.undo.describe(second.id).steps[0].before).toBe(clay.undo.describe(first.id).steps[0].after);

  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  const half = saved(clay, "r1");
  expect(half).not.toBe(both);
  expect(half).not.toBe(authored);

  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  expect(saved(clay, "r1")).toBe(authored);
});

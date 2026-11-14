/**
 * @jest-environment jsdom
 */

import { jest } from "@jest/globals";

/**
 * Structure undo around RichClay fields: remove, undo and redo of an item that holds a
 * field, add then undo, and the rule that mounting or unmounting a field never enters
 * the page history.
 */

const SLOT = "/notes.html";

const BODY = `
<ul id="links">
  <li data-id="l1"><span editable="single-line"><a href="https://example.org/a">Scholar</a></span></li>
  <li data-id="l2"><span editable="single-line"><a href="https://example.org/b">ORCID</a></span></li>
</ul>
<ul id="plain">
  <li data-id="p1"><span>Plain one</span></li>
  <li data-id="p2"><span>Plain two</span></li>
</ul>
`;

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// A real page boots once; these tests boot many times in one window, and every boot
// imports a fresh engine with its own listeners. Each one is stopped after its test, or
// the leftovers slow every later boot and an older session takes the next Cmd+Z.
const booted = [];
afterEach(() => {
  for (const clay of booted.splice(0)) clay?.undo?.stop?.();
});

async function boot({ edit = true, plugins = "undo", body = BODY, live = false } = {}) {
  jest.resetModules();
  sessionStorage.clear();
  localStorage.clear();
  delete window.clayEditMode;
  delete window.__hyperclayEditMode;
  document.cookie = "isAdminOfCurrentResource=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.cookie = "isAdminOfCurrentResource=true; path=/";
  clearRoot();
  if (live) document.documentElement.setAttribute("clay-mode-switch", "live");
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
  await settle();
  booted.push(window.clay);
  return window.clay;
}

const ids = (selector) => [...document.querySelectorAll(`${selector} [data-id]`)].map((el) => el.dataset.id);


const labels = (clay) => clay.undo.history.map((entry) => entry.label);
const field = (id) => document.querySelector(`[data-id="${id}"] [editable]`);
const active = (id) => field(id).getAttribute("data-richclay-active") === "true";
const rest = async () => { await settle(); await tick(20); };

function watchRefusals() {
  const seen = [];
  document.addEventListener("clay:undo-refused", (event) => seen.push(event.detail?.code ?? "refused"));
  return seen;
}

function watchSkips() {
  const seen = [];
  document.addEventListener("clay:undo-skipped", (event) => seen.push(event.detail?.code ?? "skipped"));
  return seen;
}

// First on purpose: an earlier edit boot in this file leaves its field watcher behind.
test("a page opened in view records nothing and mounts no field", async () => {
  const clay = await boot({ edit: false });
  expect(clay.undo).toBeUndefined();
  expect(field("l1").hasAttribute("contenteditable")).toBe(false);
  expect(field("l1").hasAttribute("data-richclay-active")).toBe(false);
});

test("remove, undo, a second undo, then redo twice, with a field inside the item", async () => {
  const clay = await boot();
  const refusals = watchRefusals();
  expect(labels(clay)).toEqual([]);
  const plain = document.querySelector('[data-id="p1"] span');
  clay.undo.commit("Rename plain", () => { plain.textContent = "Renamed"; });
  await settle();
  const item = document.querySelector('[data-id="l1"]');
  expect(active("l1")).toBe(true);
  clay.undo.commit("Remove item", () => item.remove());
  await rest();
  expect(labels(clay)).toEqual(["Rename plain", "Remove item"]);
  expect(item.querySelector("[editable]").hasAttribute("contenteditable")).toBe(false);

  await clay.undo.undo();
  await rest();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2"]);
  expect(active("l1")).toBe(true);
  expect(labels(clay)).toEqual(["Rename plain"]);
  expect(clay.undo.canRedo).toBe(true);

  await clay.undo.undo();
  await rest();
  expect(plain.textContent).toBe("Plain one");

  await clay.undo.redo();
  await rest();
  expect(plain.textContent).toBe("Renamed");
  await clay.undo.redo();
  await rest();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l2"]);

  await clay.undo.undo();
  await rest();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2"]);
});

test("add an item that holds a field, then undo and redo; the mount adds no entry", async () => {
  const clay = await boot();
  const refusals = watchRefusals();
  const list = document.querySelector("#links");
  const item = document.createElement("li");
  item.setAttribute("data-id", "l3");
  item.innerHTML = '<span editable="single-line"><a href="https://example.org/c">New</a></span>';
  clay.undo.commit("Add item", () => list.append(item));
  await rest();
  expect(active("l3")).toBe(true);
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Add item"]);

  await clay.undo.undo();
  await rest();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2"]);

  await clay.undo.redo();
  await rest();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2", "l3"]);
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Add item"]);
});

test("a field's own Undo and Redo reach the page history when the field has nothing of its own", async () => {
  const clay = await boot();
  const refusals = watchRefusals();
  const item = document.querySelector('[data-id="l1"]');
  clay.undo.commit("Remove item", () => item.remove());
  await rest();
  const other = clay.RichClay.init([field("l2")])[0];
  expect(other.canHistory("undo")).toBe(false);
  other.history("undo");
  await rest();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2"]);
  other.history("redo");
  await rest();
  expect(ids("#links")).toEqual(["l2"]);
});

test("a field mounted inside the commit that adds its item still leaves one entry", async () => {
  const clay = await boot();
  const refusals = watchRefusals();
  const list = document.querySelector("#links");
  const item = document.createElement("li");
  item.setAttribute("data-id", "l4");
  item.innerHTML = '<span editable="single-line"><a href="https://example.org/d">Inside</a></span>';
  clay.undo.commit("Add item", () => {
    list.append(item);
    clay.RichClay.init([item.querySelector("[editable]")]);
  });
  await rest();
  expect(active("l4")).toBe(true);
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Add item"]);
  await clay.undo.undo();
  await rest();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2"]);
});

test("leaving Edit drops the history, and the removed item's field keeps no editing state", async () => {
  const clay = await boot({ live: true });
  const removed = document.querySelector('[data-id="l1"]');
  const removedField = field("l1");
  clay.undo.commit("Remove item", () => removed.remove());
  await rest();
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Remove item"]);
  await expect(clay.setMode("view")).resolves.toEqual({ ok: true, mode: "view", changed: true });
  await rest();
  expect(clay.isEditMode).toBe(false);
  expect(removedField.hasAttribute("contenteditable")).toBe(false);
  expect(removedField.hasAttribute("data-richclay-active")).toBe(false);
  expect(field("l2").hasAttribute("contenteditable")).toBe(false);
  expect(clay.undo.history).toEqual([]);
  await clay.undo.undo();
  await rest();
  expect(ids("#links")).toEqual(["l2"]);
});

test("saved HTML after add and after remove holds no editor runtime state", async () => {
  const clay = await boot();
  const list = document.querySelector("#links");
  const item = document.createElement("li");
  item.setAttribute("data-id", "l3");
  item.innerHTML = '<span editable="single-line"><a href="https://example.org/c">Saved</a></span>';
  clay.undo.commit("Add item", () => list.append(item));
  await rest();
  expect(active("l3")).toBe(true);

  const added = clay.getHTML();
  expect(added).toContain('data-id="l3"');
  expect(added).not.toContain("contenteditable");
  expect(added).not.toContain("data-richclay-active");
  expect(added).not.toContain("richclay-");
  expect(added).not.toContain("editor-ui");

  clay.undo.commit("Remove item", () => item.remove());
  await rest();
  expect(ids("#links")).toEqual(["l1", "l2"]);

  const removed = clay.getHTML();
  expect(removed).toContain('data-id="l2"');
  expect(removed).toContain('data-id="l1"');
  expect(removed).not.toContain('data-id="l3"');
  expect(removed).not.toContain("contenteditable");
  expect(removed).not.toContain("data-richclay-active");
  expect(removed).not.toContain("richclay-");
  expect(removed).not.toContain("editor-ui");
});

test("move an item holding a field, then undo and redo", async () => {
  const clay = await boot({ plugins: "sortable,undo", body: BODY.replace('<ul id="links">', '<ul id="links" sortable>') });
  const refusals = watchRefusals();
  const list = document.querySelector("#links");
  const before = ids("#links");
  expect(before).toEqual(["l1", "l2"]);

  const moved = clay.sortable.move(document.querySelector('[data-id="l2"]'), list, document.querySelector('[data-id="l1"]'));
  expect(moved.ok).toBe(true);
  expect(moved.moved).toBe(true);
  await rest();
  clay.undo.flush();

  expect(ids("#links")).toEqual(["l2", "l1"]);
  expect(labels(clay)).toHaveLength(1);
  expect(active("l1")).toBe(true);
  expect(active("l2")).toBe(true);
  expect(refusals).toEqual([]);

  await clay.undo.undo();
  await rest();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(before);
  expect(active("l1")).toBe(true);
  expect(active("l2")).toBe(true);

  await clay.undo.redo();
  await rest();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l2", "l1"]);
  expect(active("l1")).toBe(true);
  expect(active("l2")).toBe(true);
});

test("a peer's newer text in a restored field skips the redo of its removal, and the text stays", async () => {
  const clay = await boot();
  const refusals = watchRefusals();
  const skips = watchSkips();
  const item = document.querySelector('[data-id="l1"]');
  clay.undo.commit("Remove item", () => item.remove());
  await rest();
  await clay.undo.undo();
  await rest();
  expect(refusals).toEqual([]);
  expect(skips).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2"]);

  const link = field("l1").querySelector("a");
  clay.Mutation.pause();
  link.textContent = "Peer label";
  clay.Mutation.resume();
  await rest();
  clay.undo.flush();
  expect(labels(clay)).toEqual([]);

  const result = await clay.undo.redo();
  await rest();
  expect(result).toMatchObject({ ok: false, code: "empty", direction: "redo" });
  expect(skips).toEqual(["content-changed"]);
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2"]);
  expect(clay.getHTML()).toContain("Peer label");
  expect(clay.undo.canRedo).toBe(false);
});

test("typing into a newly added rich item, then page undo, skips instead of deleting the typed text", async () => {
  const clay = await boot();
  const refusals = watchRefusals();
  const skips = watchSkips();
  const list = document.querySelector("#links");
  const item = document.createElement("li");
  item.setAttribute("data-id", "l3");
  item.innerHTML = '<span editable="single-line">New</span>';
  clay.undo.commit("Add item", () => list.append(item));
  await rest();
  expect(active("l3")).toBe(true);
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Add item"]);

  clay.Mutation.pause();
  field("l3").textContent = "Typed title";
  clay.Mutation.resume();
  await rest();
  clay.undo.flush();
  expect(labels(clay)).toEqual(["Add item"]);

  const result = await clay.undo.undo();
  await rest();
  expect(result).toMatchObject({ ok: false, code: "empty", direction: "undo" });
  expect(skips).toEqual(["content-changed"]);
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2", "l3"]);
  expect(field("l3").textContent).toBe("Typed title");
  expect(clay.undo.canUndo).toBe(false);
});

test("an author's own no-undo on a rich field keeps it protected", async () => {
  const body = BODY.replace(
    '<span editable="single-line"><a href="https://example.org/a">Scholar</a></span>',
    '<span editable="single-line" no-undo><a href="https://example.org/a">Scholar</a></span>'
  );
  expect(body).not.toEqual(BODY);
  const clay = await boot({ body });
  const refusals = watchRefusals();
  const skips = watchSkips();
  expect(field("l1").hasAttribute("no-undo")).toBe(true);
  expect(field("l1").hasAttribute("data-richclay-runtime-no-undo")).toBe(false);

  const item = document.querySelector('[data-id="l1"]');
  clay.undo.commit("Remove item", () => item.remove());
  await rest();
  await clay.undo.undo();
  await rest();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2"]);

  const result = await clay.undo.redo();
  await rest();
  expect(result).toMatchObject({ ok: false, code: "empty", direction: "redo" });
  expect(skips).toEqual(["protected"]);
  expect(refusals).toEqual([]);
  expect(item.isConnected).toBe(true);
  expect(ids("#links")).toEqual(["l1", "l2"]);
});

// From the M1 fix re-review: mounting rewrites the field element's own attributes
// with no edit, and none of these may refuse undo of an untouched add.
for (const [name, extra] of [
  ["compact inline style", ' style="color:red"'],
  ["bare contenteditable", " contenteditable"],
  ["inert-contenteditable true", ' inert-contenteditable="true"'],
  ["inert-contenteditable with a class after it", ' inert-contenteditable="false" class="title"'],
]) {
  test(`an untouched added field with ${name} undoes and redoes`, async () => {
    const clay = await boot();
    const item = document.createElement("li");
    item.dataset.id = "new";
    item.innerHTML = `<span editable="single-line"${extra}>Untyped title</span>`;
    clay.undo.commit("Add item", () => document.querySelector("#links").append(item));
    await rest();
    clay.undo.flush();
    expect(labels(clay)).toEqual(["Add item"]);
    expect(item.firstChild.getAttribute("data-richclay-active")).toBe("true");
    expect(clay.undo.undo().ok).toBe(true);
    expect(item.isConnected).toBe(false);
    await rest();
    expect(clay.undo.redo().ok).toBe(true);
    await rest();
    expect(item.isConnected).toBe(true);
  });
}

test("an ephemeral mark on a restored field does not block redo of its removal", async () => {
  const clay = await boot({ body: BODY.replace('<span editable="single-line">', '<span editable="single-line"><b ephemeral:data-selected>') .replace("</span>", "</b></span>") });
  const item = document.querySelector('[data-id="l1"]');
  clay.undo.commit("Remove item", () => item.remove());
  await rest();
  expect(clay.undo.undo().ok).toBe(true);
  await rest();
  const mark = field("l1").querySelector("b");
  const before = clay.getHTML();
  mark.setAttribute("data-selected", "true");
  await rest();
  expect(clay.getHTML()).toBe(before);
  expect(clay.undo.redo().ok).toBe(true);
  expect(item.isConnected).toBe(false);
});

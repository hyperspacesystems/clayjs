/**
 * @jest-environment jsdom
 */

import { jest } from "@jest/globals";

/**
 * Undo after a list item that holds a RichClay field is removed.
 *
 * The control removes a plain item and Cmd+Z brings it back. The item that holds an
 * `<span editable="single-line">` is the case under test: if RichClay's watcher
 * destroys the editor of a field that leaves the document and strips its runtime
 * attributes from the detached node, the engine's saved copy no longer matches and
 * the undo is refused instead of replayed.
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
  return window.clay;
}

const ids = (selector) => [...document.querySelectorAll(`${selector} [data-id]`)].map((el) => el.dataset.id);

test("control: a removed plain item comes back on undo", async () => {
  const clay = await boot();
  const removed = document.querySelector('[data-id="p1"]');
  clay.undo.commit("Remove item", () => removed.remove());
  await settle();
  await tick(20);
  await clay.undo.undo();
  await settle();
  expect(ids("#plain")).toEqual(["p1", "p2"]);
});

test("a removed item holding a RichClay field comes back on undo", async () => {
  const clay = await boot();
  const field = document.querySelector('[data-id="l1"] [editable]');
  expect(field.getAttribute("data-richclay-active")).toBe("true");

  const refusals = [];
  document.addEventListener("clay:undo-refused", (event) => refusals.push(event.detail));

  const removed = document.querySelector('[data-id="l1"]');
  clay.undo.commit("Remove item", () => removed.remove());
  await settle();
  await tick(20);
  await clay.undo.undo();
  await settle();
  expect(refusals).toEqual([]);
  expect(ids("#links")).toEqual(["l1", "l2"]);
  expect(document.querySelector('[data-id="l1"]').textContent).toContain("Scholar");
});

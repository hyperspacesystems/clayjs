/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/page.html"}
 */
import { jest } from "@jest/globals";
import { seedValue } from "../../../src/page/ybind/seed.js";
import { renderFromTags } from "../../../src/page/save-projection.js";

/**
 * Two tabs of a visitor's draft page. Each test boots one tab in a window where the
 * previous tab's listeners are gone, so only the tab in front answers an event.
 */

const BLOCKS = [
  { id: "title", t: "heading", text: "" },
  { id: "p1", t: "paragraph", text: "" },
];
const RULES = '{"title":"title"}';

let boots = 0;
const listeners = [];
const natives = new Map();

function track(target) {
  if (natives.has(target)) return;
  const add = target.addEventListener;
  const remove = target.removeEventListener;
  natives.set(target, { add, remove });
  target.addEventListener = function (type, fn, options) {
    listeners.push({ target, type, fn, options });
    return add.call(this, type, fn, options);
  };
  target.removeEventListener = function (type, fn, options) {
    const at = listeners.findIndex((item) => item.target === target && item.type === type && item.fn === fn);
    if (at >= 0) listeners.splice(at, 1);
    return remove.call(this, type, fn, options);
  };
}

// A boot's listeners stay on the window after its session ends, so the next boot's
// events would reach the tab that is no longer in front.
function dropListeners() {
  for (const { target, type, fn, options } of listeners.splice(0)) natives.get(target).remove.call(target, type, fn, options);
}

track(window);
track(document);

function articleHtml() {
  const { html, rev } = renderFromTags([JSON.stringify(seedValue(BLOCKS))]);
  return `<article class="page" clay="freeze" data-page="1" data-rev="${rev}">${html}</article>`;
}

async function bootPage({ tagText = null, slot: wanted = null, storage = null } = {}) {
  window.clay?.page?.dispose?.();
  await wait(400);
  dropListeners();
  jest.resetModules();
  const slot = wanted ?? `page-draft-tabs-${++boots}`;
  delete window.clayEditMode;
  delete window.__hyperclayEditMode;
  const root = document.documentElement;
  for (const name of Array.from(root.attributes, (a) => a.name)) root.removeAttribute(name);
  root.setAttribute("visitor-drafts", slot);
  root.setAttribute("opens-in", "edit");
  document.head.innerHTML = "<title>Page</title>";
  const rules = document.createElement("script");
  rules.setAttribute("type", "application/json");
  rules.setAttribute("data-rules-name", "api");
  rules.setAttribute("data-rules-version", "1");
  rules.textContent = RULES;
  document.head.append(rules);
  const settings = document.createElement("script");
  settings.setAttribute("type", "application/json");
  settings.setAttribute("merge", "page.settings");
  settings.setAttribute("clay", "live");
  settings.textContent = "{}";
  document.head.append(settings);
  document.body.innerHTML = articleHtml();
  if (tagText) {
    const tag = document.createElement("script");
    tag.setAttribute("type", "application/json");
    tag.setAttribute("merge", "page");
    tag.setAttribute("clay", "live");
    tag.textContent = tagText;
    const article = document.querySelector("article[data-page]");
    article.parentNode.insertBefore(tag, article);
  }
  localStorage.clear();
  sessionStorage.clear();
  if (storage) for (const [name, value] of Object.entries(storage)) localStorage.setItem(name, value);
  window.history.replaceState({}, "", "/page.html");
  window.clay = {};
  const fetchMock = jest.fn(async () => { throw new Error("no host request is allowed in draft mode"); });
  window.fetch = fetchMock;
  global.fetch = fetchMock;
  await import("../../../src/ui/toast.js");
  await import("../../../src/lib/region-policy.js");
  const { boot } = await import("../../../src/loader.js");
  await new Promise((resolve) => boot(null, new URLSearchParams("plugins=page,visitor-drafts,indicator"), resolve));
  return { clay: window.clay, fetchMock };
}

async function tapDraftTransport() {
  const draftMode = await import("../../../src/core/draft-mode.js");
  const send = draftMode.draftTransport();
  if (!send) throw new Error("this boot set no draft transport");
  const bytes = [];
  draftMode.setDraftTransport((html) => {
    bytes.push(html);
    return send(html);
  });
  return bytes;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(50);
  }
  return predicate();
}

function firstParagraph(view) {
  let pos = null;
  view.state.doc.descendants((node, at) => {
    if (pos === null && node.type.name === "paragraph") pos = at + 1;
  });
  return pos;
}

function recordReader(slot) {
  const key = `clay:visitor-drafts:${slot}@/page.html`;
  const recordOf = () => {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  };
  return { key, recordOf };
}

test("two tabs typing different paragraphs both keep their words", async () => {
  const slot = "page-draft-tabs-both";
  const { key, recordOf } = recordReader(slot);

  const b = await bootPage({ slot });
  await b.clay.page.ready;
  const bView = b.clay.page.view;
  bView.dispatch(bView.state.tr.insertText("bravo", firstParagraph(bView)));
  await waitFor(() => recordOf()?.page?.html?.includes("bravo"));
  const rawB = localStorage.getItem(key);
  expect(rawB).toBeTruthy();

  const a = await bootPage({ slot });
  await a.clay.page.ready;
  const bytes = await tapDraftTransport();
  const aView = a.clay.page.view;
  aView.dispatch(aView.state.tr.insertText("alpha", firstParagraph(aView)));
  await waitFor(() => bytes.some((html) => html.includes("alpha")) && recordOf()?.page?.html?.includes("alpha"));
  expect(aView.state.doc.textContent).not.toContain("bravo");

  localStorage.setItem(key, rawB);
  window.dispatchEvent(new StorageEvent("storage", { key }));

  const both = () => aView.state.doc.textContent.includes("alpha") && aView.state.doc.textContent.includes("bravo");
  await waitFor(both);
  expect(aView.state.doc.textContent).toContain("alpha");
  expect(aView.state.doc.textContent).toContain("bravo");

  aView.dispatch(aView.state.tr.insertText("!", firstParagraph(aView)));
  await waitFor(() => recordOf()?.page?.html?.includes("!") && recordOf()?.page?.html?.includes("alpha") && recordOf()?.page?.html?.includes("bravo"));
  const record = recordOf();
  expect(record.page.html).toContain("alpha");
  expect(record.page.html).toContain("bravo");
  expect(localStorage.getItem(key + ":conflict")).toBeNull();

  const third = await bootPage({ slot, storage: { [key]: localStorage.getItem(key) } });
  await third.clay.page.ready;
  expect(third.clay.page.view.state.doc.textContent).toContain("alpha");
  expect(third.clay.page.view.state.doc.textContent).toContain("bravo");
}, 60000);

test("without the page editor's merge, the other tab's page is kept aside", async () => {
  const slot = "page-draft-tabs-unmerged";
  const { key, recordOf } = recordReader(slot);

  const b = await bootPage({ slot });
  await b.clay.page.ready;
  const bView = b.clay.page.view;
  bView.dispatch(bView.state.tr.insertText("bravo", firstParagraph(bView)));
  await waitFor(() => recordOf()?.page?.html?.includes("bravo"));
  const rawB = localStorage.getItem(key);
  expect(rawB).toBeTruthy();

  const a = await bootPage({ slot });
  await a.clay.page.ready;
  const bytes = await tapDraftTransport();
  const aView = a.clay.page.view;
  aView.dispatch(aView.state.tr.insertText("alpha", firstParagraph(aView)));
  await waitFor(() => bytes.some((html) => html.includes("alpha")) && recordOf()?.page?.html?.includes("alpha"));

  localStorage.setItem(key, rawB);
  aView.dispatch(aView.state.tr.insertText("!", firstParagraph(aView)));
  await waitFor(() => recordOf()?.id && localStorage.getItem(key) !== rawB && recordOf()?.page?.html?.includes("!"));

  expect(localStorage.getItem(key + ":conflict")).toBe(rawB);
  const record = recordOf();
  expect(record.page.html).toContain("alpha");
  expect(record.page.html).not.toContain("bravo");
}, 60000);

test("a hide right after a merge keeps this tab's saved words", async () => {
  const slot = "page-draft-tabs-hide";
  const { key, recordOf } = recordReader(slot);

  const b = await bootPage({ slot });
  await b.clay.page.ready;
  const bView = b.clay.page.view;
  bView.dispatch(bView.state.tr.insertText("bravo", firstParagraph(bView)));
  await waitFor(() => recordOf()?.page?.html?.includes("bravo"));
  const rawB = localStorage.getItem(key);
  expect(rawB).toBeTruthy();

  const a = await bootPage({ slot });
  await a.clay.page.ready;
  const bytes = await tapDraftTransport();
  const aView = a.clay.page.view;
  aView.dispatch(aView.state.tr.insertText("alpha", firstParagraph(aView)));
  await waitFor(() => bytes.some((html) => html.includes("alpha")) && recordOf()?.page?.html?.includes("alpha"));

  localStorage.setItem(key, rawB);
  window.dispatchEvent(new StorageEvent("storage", { key }));
  window.dispatchEvent(new Event("pagehide"));

  const record = recordOf();
  expect(record).toBeTruthy();
  expect(record.page.html).toContain("alpha");
  expect(record.page.html).toContain("bravo");
}, 60000);

test("a tab that took in the other tab's page follows Start over", async () => {
  const slot = "page-draft-tabs-reset";
  const { key, recordOf } = recordReader(slot);

  const a = await bootPage({ slot });
  await a.clay.page.ready;
  const aView = a.clay.page.view;
  aView.dispatch(aView.state.tr.insertText("alpha", firstParagraph(aView)));
  await waitFor(() => recordOf()?.page?.html?.includes("alpha"));
  const rawA = localStorage.getItem(key);
  expect(rawA).toBeTruthy();

  const b = await bootPage({ slot });
  await b.clay.page.ready;
  const bView = b.clay.page.view;
  expect(bView.state.doc.textContent).not.toContain("alpha");

  localStorage.setItem(key, rawA);
  window.dispatchEvent(new StorageEvent("storage", { key }));
  await waitFor(() => bView.state.doc.textContent.includes("alpha"));
  expect(bView.state.doc.textContent).toContain("alpha");

  localStorage.removeItem(key);
  window.dispatchEvent(new StorageEvent("storage", { key }));
  window.dispatchEvent(new Event("pagehide"));

  expect(localStorage.getItem(key)).toBeNull();
}, 60000);

test("a page recorded before the editor listened is taken in once it listens", async () => {
  const slot = "page-draft-tabs-listening";
  const { key, recordOf } = recordReader(slot);

  const a = await bootPage({ slot });
  await a.clay.page.ready;
  const aView = a.clay.page.view;
  aView.dispatch(aView.state.tr.insertText("other", firstParagraph(aView)));
  await waitFor(() => recordOf()?.page?.html?.includes("other"));
  const rawA = localStorage.getItem(key);
  expect(rawA).toBeTruthy();

  const dispatching = jest.spyOn(document, "dispatchEvent");
  const b = await bootPage({ slot });
  await b.clay.page.ready;
  const announced = dispatching.mock.calls.filter(([event]) => event?.type === "clay:drafts-page-listening");
  dispatching.mockRestore();
  expect(announced.length).toBe(1);

  const bView = b.clay.page.view;
  expect(bView.state.doc.textContent).not.toContain("other");

  localStorage.setItem(key, rawA);
  document.dispatchEvent(new CustomEvent("clay:drafts-page-listening"));
  await waitFor(() => bView.state.doc.textContent.includes("other"));
  expect(bView.state.doc.textContent).toContain("other");
}, 60000);

test("only the tab in front answers another tab's page", async () => {
  const slot = "page-draft-tabs-one-listener";
  const first = await bootPage({ slot });
  await first.clay.page.ready;
  const second = await bootPage({ slot });
  await second.clay.page.ready;

  const adopted = jest.fn();
  document.dispatchEvent(new CustomEvent("clay:drafts-page-external", { detail: { live: { page: seedValue(BLOCKS) }, adopted } }));
  expect(adopted).toHaveBeenCalledTimes(1);
}, 40000);

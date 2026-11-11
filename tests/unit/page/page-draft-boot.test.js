/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/page.html"}
 */
import { jest } from "@jest/globals";
import { seedValue } from "../../../src/page/ybind/seed.js";
import { renderFromTags } from "../../../src/page/save-projection.js";

/**
 * A visitor's draft (draft mode, `<html visitor-drafts>`) on a document that names
 * `page` keeps the real editor: it edits the page, saves into this browser's draft
 * transport, and restores from it, with no request to the host.
 */

const BLOCKS = [
  { id: "title", t: "heading", text: "" },
  { id: "p1", t: "paragraph", text: "" },
];
const TAG_SEL = 'script[type="application/json"][merge="blockeditor"][clay~="live"]';
const RULES = '{"title":"title"}';

let boots = 0;

function articleHtml() {
  const { html, rev } = renderFromTags([JSON.stringify(seedValue(BLOCKS))]);
  return `<article class="blockeditor" clay="freeze" data-blockeditor="1" data-rev="${rev}">${html}</article>`;
}

// The boot the spike proved: a draft slot and no owner cookie, the page's own rules
// tag, and a fetch that refuses every call so a host request cannot pass unnoticed.
// The previous boot is disposed and settled first: its editor's work still running
// would otherwise evaluate the mode modules for the next boot's plan.
async function bootPage({ tagText = null, slot: wanted = null, storage = null } = {}) {
  window.clay?.blockeditor?.dispose?.();
  await wait(400);
  jest.resetModules();
  const slot = wanted ?? `blockeditor-draft-${++boots}`;
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
  settings.setAttribute("merge", "blockeditor.settings");
  settings.setAttribute("clay", "live");
  settings.textContent = "{}";
  document.head.append(settings);
  document.body.innerHTML = articleHtml();
  if (tagText) {
    const tag = document.createElement("script");
    tag.setAttribute("type", "application/json");
    tag.setAttribute("merge", "blockeditor");
    tag.setAttribute("clay", "live");
    tag.textContent = tagText;
    const article = document.querySelector("article[data-blockeditor]");
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
  // The two modules the boot reaches by a dynamic import late enough that jest's
  // module registry of the moment cannot link them: primed here, they are cached.
  await import("../../../src/ui/toast.js");
  await import("../../../src/lib/region-policy.js");
  const { boot } = await import("../../../src/loader.js");
  await new Promise((resolve) => boot(null, new URLSearchParams("plugins=blockeditor,visitor-drafts,indicator"), resolve));
  return { clay: window.clay, fetchMock };
}

// The bytes a save hands the draft transport, wrapped rather than replaced so the
// record in this browser is the one the transport really wrote.
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

const docOf = (html) => new DOMParser().parseFromString(html, "text/html");

// The slash menu, opened the way a person does: the caret in an empty line and the
// character typed into it. jsdom has no layout, so the caret's coordinates are stubbed.
async function openSlashMenu(view) {
  const pm = await import("../../../src/vendor/prosemirror.vendor.js");
  view.coordsAtPos = () => ({ left: 40, right: 48, top: 100, bottom: 120 });
  view.focus();
  view.dispatch(view.state.tr.setSelection(pm.state.TextSelection.create(view.state.doc, firstParagraph(view))));
  const { from, to } = view.state.selection;
  view.dispatch(view.state.tr.insertText("/", from, to));
  return view.dom.parentElement.querySelector(".blockeditor-menu");
}

const menuLabels = (menu) => [...menu.querySelectorAll(".blockeditor-menu-item .blockeditor-menu-label")].map((n) => n.textContent);

test("a visitor's page boots editable with no host request", async () => {
  const { clay, fetchMock } = await bootPage();
  const status = await clay.blockeditor.ready;
  expect(status.phase).toBe("ready");
  expect(clay.blockeditor.view.editable).toBe(true);
  expect(fetchMock.mock.calls.length).toBe(0);
}, 30000);

test("a visitor's typing saves into this browser's draft transport", async () => {
  const { clay, fetchMock } = await bootPage();
  await clay.blockeditor.ready;
  const bytes = await tapDraftTransport();
  const view = clay.blockeditor.view;
  view.dispatch(view.state.tr.insertText("visitor words", firstParagraph(view)));

  await waitFor(() => bytes.some((html) => html.includes("visitor words")));
  expect(bytes.length).toBeGreaterThan(0);
  const saved = bytes.find((html) => html.includes("visitor words"));
  expect(saved).toBeTruthy();
  const doc = docOf(saved);
  expect(doc.querySelectorAll(TAG_SEL).length).toBe(1);
  expect(doc.querySelector("article[data-blockeditor]").textContent).toContain("visitor words");
  expect(fetchMock.mock.calls.length).toBe(0);

  const tagText = doc.querySelector(TAG_SEL).textContent;
  const second = await bootPage({ tagText });
  await second.clay.blockeditor.ready;
  expect(second.clay.blockeditor.view.state.doc.textContent).toContain("visitor words");
  expect(second.fetchMock.mock.calls.length).toBe(0);
}, 40000);

test("a return visit boots from a stored page tag", async () => {
  const first = await bootPage();
  await first.clay.blockeditor.ready;
  const bytes = await tapDraftTransport();
  const view = first.clay.blockeditor.view;
  view.dispatch(view.state.tr.insertText("kept words", firstParagraph(view)));
  await waitFor(() => bytes.some((html) => html.includes("kept words")));
  const saved = bytes.find((html) => html.includes("kept words"));
  expect(saved).toBeTruthy();
  const tagText = docOf(saved).querySelector(TAG_SEL).textContent;
  expect(tagText).toBeTruthy();

  const second = await bootPage({ tagText });
  await second.clay.blockeditor.ready;
  expect(second.clay.blockeditor.view.state.doc.textContent).toContain("kept words");
  expect(second.fetchMock.mock.calls.length).toBe(0);
}, 40000);

test("a reload finds the visitor's page from the record alone", async () => {
  const slot = "blockeditor-draft-reload";
  const first = await bootPage({ slot });
  await first.clay.blockeditor.ready;
  const bytes = await tapDraftTransport();
  const view = first.clay.blockeditor.view;
  view.dispatch(view.state.tr.insertText("record words", firstParagraph(view)));

  const key = `clay:visitor-drafts:${slot}@/page.html`;
  const recordOf = () => {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  };
  await waitFor(() => bytes.some((html) => html.includes("record words")) && recordOf()?.blockeditor?.html?.includes("record words"));
  const raw = localStorage.getItem(key);
  expect(raw).toBeTruthy();
  const record = JSON.parse(raw);
  expect(record.blockeditor.html).toContain("record words");
  expect(record.live.blockeditor).toBeTruthy();

  const second = await bootPage({ slot, storage: { [key]: raw } });
  await second.clay.blockeditor.ready;
  expect(second.clay.blockeditor.view.state.doc.textContent).toContain("record words");
  expect(second.fetchMock.mock.calls.length).toBe(0);
}, 40000);

test("a visitor's slash menu has no Image or File, and shows the note", async () => {
  const { clay } = await bootPage();
  await clay.blockeditor.ready;
  const menu = await openSlashMenu(clay.blockeditor.view);
  expect(menu).toBeTruthy();
  const labels = menuLabels(menu);
  expect(labels).not.toContain("Image");
  expect(labels).not.toContain("File");
  expect(labels).toContain("Text");
  expect(menu.querySelector(".blockeditor-menu-note").textContent).toBe("Download your copy to add pictures and files.");
}, 30000);

test("a visitor's more menu has no Add cover", async () => {
  const { clay } = await bootPage();
  await clay.blockeditor.ready;
  const view = clay.blockeditor.view;
  const more = view.dom.parentElement.querySelector(".blockeditor-dock .blockeditor-tool-more");
  expect(more).toBeTruthy();
  more.click();
  const menu = view.dom.parentElement.querySelector(".blockeditor-menu");
  expect(menu).toBeTruthy();
  const labels = menuLabels(menu);
  expect(labels).not.toContain("Add cover");
  expect(labels).toContain("Page icon");
}, 30000);

test("a visitor's dropped image is refused with the note, not offered as an embed", async () => {
  const { clay } = await bootPage();
  await clay.blockeditor.ready;
  const view = clay.blockeditor.view;
  const { mediaKey, insertFiles } = await import("../../../src/page/media.js");
  const item = () => mediaKey.getState(view.state).items[0];
  insertFiles(view, [new File(["x"], "a.png", { type: "image/png" })]);
  await waitFor(() => item()?.state !== "uploading");
  expect(item().state).toBe("error");
  expect(item().state).not.toBe("embed-choice");
  expect(item().message).toBe("Download your copy to add pictures and files.");
}, 30000);

test("no persistent storage warning appears for a visitor", async () => {
  const { clay } = await bootPage();
  await clay.blockeditor.ready;
  expect(clay.blockeditor.view.editable).toBe(true);
  // The save-state notices arrive after the boot settles: a draft with no host has
  // nothing to be unavailable about, so neither the storage toast nor the chip's
  // "can't store changes" status appears.
  await wait(1200);
  const text = document.body.textContent;
  expect(text).not.toContain("Changes cannot be stored on this device");
  expect(text).not.toContain("Can't store changes");
}, 30000);

test("the same harness counts host requests for an owner", async () => {
  const answer = { ok: false, status: 404, headers: new Headers(), text: async () => "", json: async () => ({}) };
  window.clay?.blockeditor?.dispose?.();
  await wait(800);
  jest.resetModules();
  // The owner's document loads sync, whose stream opens an EventSource jsdom lacks.
  class FakeEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
    }
    close() {
      this.closed = true;
    }
  }
  global.EventSource = FakeEventSource;
  window.EventSource = FakeEventSource;
  await import("../../../src/ui/toast.js");
  await import("../../../src/lib/region-policy.js");
  const fetchMock = jest.fn(async () => answer);
  const { boot } = await import("../../../src/loader.js");
  const root = document.documentElement;
  for (const name of Array.from(root.attributes, (a) => a.name)) root.removeAttribute(name);
  root.setAttribute("opens-in", "edit");
  document.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${RULES}</script>`;
  document.body.innerHTML = articleHtml();
  localStorage.clear();
  window.clay = {};
  window.clayEditMode = true;
  window.fetch = fetchMock;
  global.fetch = fetchMock;
  await new Promise((resolve) => boot(null, new URLSearchParams("plugins=blockeditor,indicator"), resolve));
  expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  await Promise.resolve(window.clay.blockeditor?.ready).catch(() => {});
  await wait(500);
}, 30000);

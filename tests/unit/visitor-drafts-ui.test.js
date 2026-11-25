/**
 * The runtime chrome the visitor-drafts plugin puts on a free app in draft mode:
 * the intro area (including its [visitor-intro-download] CTA), the lazy storage-error
 * rescue card, the owner-only chip, their per-slot memory, and the ?src= channel
 * that rides along in the download link. Everything here is thrown away on reload
 * and never reaches the document.
 */
import { jest } from "@jest/globals";
import { draftKey } from "../../src/plugins/visitor-drafts/store.js";
import { $, active, hostOf } from "./helpers/editor-ui.js";

const PARAMS = "plugins=visitor-drafts&exclude=richclay,source";
const RULES = '{"title":"#title","note":"#note@value"}';
const INTRO = '<template visitor-intro><p>Track your week.</p><a href="/_/download?as=htmlclay" visitor-intro-download>Download Notes</a></template>';

const keyFor = (slot) => draftKey(slot) + ":ui";
const draftKeyFor = (slot) => draftKey(slot);

function clearCookies() {
  document.cookie = "isAdminOfCurrentResource=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

function setOwnerCookie() {
  document.cookie = "isAdminOfCurrentResource=true; path=/";
}

function setPage({ slot, keepStorage = false, head = "", template = "", ui = null, draft = null, body = "" }) {
  const root = document.documentElement;
  for (const name of Array.from(root.attributes, (attribute) => attribute.name)) root.removeAttribute(name);
  if (slot) root.setAttribute("visitor-drafts", slot);
  document.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${RULES}</script>` + head;
  document.body.innerHTML = '<h1 id="title">owner title</h1><input id="note" persist value="owner note">' + body + template;
  if (!keepStorage) localStorage.clear();
  if (ui) localStorage.setItem(keyFor(slot), JSON.stringify(ui));
  if (draft) localStorage.setItem(draftKeyFor(slot), JSON.stringify(draft));
}

function notFound() {
  return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
}

async function bootPage({
  slot,
  params = PARAMS,
  owner = false,
  url = "/notes.html",
  keepStorage = false,
  head = "",
  template = "",
  ui = null,
  draft = null,
  body = "",
  beforeBoot = null,
} = {}) {
  jest.resetModules();
  delete window.clayEditMode;
  delete window.__hyperclayEditMode;
  clearCookies();
  if (owner) setOwnerCookie();
  window.history.replaceState({}, "", url);
  setPage({ slot, keepStorage, head, template, ui, draft, body });
  window.clay = {};
  window.scrollTo = () => {};
  window.scrollBy = () => {};
  const fetchMock = jest.fn(async () => notFound());
  window.fetch = fetchMock;
  global.fetch = fetchMock;
  const { boot } = await import("../../src/loader.js");
  if (beforeBoot) beforeBoot();
  await new Promise((resolve) => boot(null, new URLSearchParams(params), resolve));
  return { clay: window.clay, fetchMock, key: keyFor(slot) };
}

function intro() {
  return document.querySelector(".clay-intro");
}

function ownerChip() {
  return $(".clay-owner", "owner");
}

function styleText(id) {
  return document.getElementById(id).textContent;
}

function prompt() {
  return $(".hcp", "download-prompt");
}

async function triggerStorageError(detail = { error: new Error("full") }) {
  document.dispatchEvent(new CustomEvent("clay:drafts-store-failed", { detail }));
  for (let i = 0; i < 20 && !prompt(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return prompt();
}

function clickDownload() {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  prompt().querySelector("[data-hcp-link] span").dispatchEvent(event);
  return event;
}

async function withDownloadStubs(run) {
  const blobs = [];
  const downloads = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  const realClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => { blobs.push(blob); return "blob:clay-test"; };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, download: this.download }); };
  try {
    run();
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    HTMLAnchorElement.prototype.click = realClick;
  }
  return { blobs, downloads };
}

function readBlob(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });
}

test("draft mode mounts no floating prompt on load and wires [visitor-intro-download] to this page's download URL", async () => {
  const { clay } = await bootPage({ slot: "ui-prompt-1", url: "/", template: INTRO });
  expect(hostOf("download-prompt")).toBeNull();
  expect(clay.visitorDrafts.downloadUrl()).toBe("/_/download?as=htmlclay");
  expect(intro().querySelector("[visitor-intro-download]").getAttribute("href")).toBe("/_/download?as=htmlclay");
  expect(document.querySelector("head link[href*='fonts.googleapis.com']")).toBeNull();

  const forms = [
    ["/kanban", "/_/download?as=htmlclay"],
    ["/kanban.html", "/_/download/kanban.html?as=htmlclay"],
    ["/apps/kanban.html", "/_/download/apps/kanban.html?as=htmlclay"],
    ["/apps/kanban/", "/_/download?as=htmlclay"],
  ];
  for (const [path, expected] of forms) {
    const next = await bootPage({ slot: "ui-prompt-" + path.replace(/\W/g, "-"), url: path, template: INTRO });
    expect(hostOf("download-prompt")).toBeNull();
    expect(next.clay.visitorDrafts.downloadUrl()).toBe(expected);
    expect(intro().querySelector("[visitor-intro-download]").getAttribute("href")).toBe(expected);
  }
});

test("clicking [visitor-intro-download] flushes drafts and follows the download link", async () => {
  await bootPage({ slot: "ui-intro-dl-click", url: "/kanban.html?src=hn", template: INTRO });
  const cta = intro().querySelector("[visitor-intro-download]");
  expect(cta.getAttribute("href")).toBe("/_/download/kanban.html?as=htmlclay&src=hn");

  const clicks = [];
  const onClick = (event) => {
    const link = event.composedPath().find((el) => el instanceof Element && el.tagName === "A");
    if (!link) return;
    clicks.push({ href: link.getAttribute("href"), prevented: event.defaultPrevented });
    event.preventDefault();
  };
  document.addEventListener("click", onClick);
  try {
    cta.click();
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    document.removeEventListener("click", onClick);
  }

  expect(clicks).toEqual([
    { href: "/_/download/kanban.html?as=htmlclay&src=hn", prevented: true },
    { href: "/_/download/kanban.html?as=htmlclay&src=hn", prevented: false },
  ]);
});

test("the first ?src= for a slot is kept and never replaced", async () => {
  const first = await bootPage({ slot: "ui-src-1", url: "/kanban.html?src=bsky", template: INTRO });
  expect(first.clay.visitorDrafts.source).toBe("bsky");
  expect(first.clay.visitorDrafts.downloadUrl()).toBe("/_/download/kanban.html?as=htmlclay&src=bsky");
  expect(intro().querySelector("[visitor-intro-download]").getAttribute("href")).toBe("/_/download/kanban.html?as=htmlclay&src=bsky");
  expect(JSON.parse(localStorage.getItem(keyFor("ui-src-1"))).src).toBe("bsky");

  const second = await bootPage({ slot: "ui-src-1", url: "/kanban.html", keepStorage: true, template: INTRO });
  expect(second.clay.visitorDrafts.source).toBe("bsky");
  expect(second.clay.visitorDrafts.downloadUrl()).toBe("/_/download/kanban.html?as=htmlclay&src=bsky");

  const third = await bootPage({ slot: "ui-src-1", url: "/kanban.html?src=x", keepStorage: true, template: INTRO });
  expect(third.clay.visitorDrafts.source).toBe("bsky");
  expect(third.clay.visitorDrafts.downloadUrl()).toBe("/_/download/kanban.html?as=htmlclay&src=bsky");

  const invalid = await bootPage({ slot: "ui-src-2", url: "/kanban.html?src=%3Cb%3E", template: INTRO });
  expect(invalid.clay.visitorDrafts.source).toBe(null);
  expect(invalid.clay.visitorDrafts.downloadUrl()).toBe("/_/download/kanban.html?as=htmlclay");
  expect(localStorage.getItem(keyFor("ui-src-2"))).toBeNull();
});

test("a route after the document keeps the download on the document, not on a path with .html appended", async () => {
  const forms = [
    ["/journal/2026-05.html/entry/3", "/_/download/journal/2026-05.html?as=htmlclay"],
    ["/notes.htmlclay/today", "/_/download/notes.htmlclay?as=htmlclay"],
    ["/index.html/today", "/_/download?as=htmlclay"],
    ["/their-site/notes.html/today", "/_/download/their-site/notes.html?as=htmlclay"],
  ];
  for (const [url, expected] of forms) {
    const { clay } = await bootPage({ slot: "ui-route-" + url.replace(/\W/g, "-"), url, template: INTRO });
    expect(intro().querySelector("[visitor-intro-download]").getAttribute("href")).toBe(expected);
    expect(clay.visitorDrafts.downloadUrl()).toBe(expected);
  }
});

test("a page that is not in draft mode gets no prompt", async () => {
  await bootPage({ slot: "ui-off-1", owner: true, url: "/notes.html?editmode=true" });
  expect(hostOf("download-prompt")).toBeNull();
  expect(intro()).toBeNull();
  expect([...document.querySelectorAll("[clay='editor-ui']")].map((el) => el.getAttribute("data-clay-ui") || el.id)).toEqual(["clay-owner-vars", "owner"]);

  await bootPage({ slot: "ui-off-2", params: "plugins=undo&exclude=richclay,source" });
  expect(hostOf("download-prompt")).toBeNull();
  expect(hostOf("owner")).toBeNull();
});

test("a failed browser write mounts the error card lazily, minimize keeps a reopen tab, and a later save hides it", async () => {
  const { clay } = await bootPage({ slot: "ui-error-1" });
  expect(hostOf("download-prompt")).toBeNull();

  const aside = await triggerStorageError();
  expect(aside.hidden).toBe(false);
  expect(aside.getAttribute("data-hcp-state")).toBe("card");
  expect(aside.getAttribute("data-hcp-reason")).toBe("error");
  expect(aside.querySelector('.hcp-title [data-hcp-for="error"]').textContent).toBe("Your work isn't being saved in this browser.");
  expect(aside.querySelector('.hcp-body [data-hcp-for="error"]').textContent).toBe("Storage is full or turned off here. Download the file to keep what you've done.");
  expect(clay.getHTML()).not.toContain('id="hcp"');
  expect(clay.getHTML()).not.toContain("clay-editor-ui");

  aside.querySelector('.hcp-quiet[data-hcp="dismiss"]').click();
  expect(aside.getAttribute("data-hcp-state")).toBe("mini");
  expect(active()).toBe(aside.querySelector("[data-hcp=open]"));

  document.dispatchEvent(new CustomEvent("clay:drafts-saved", { detail: {} }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(aside.hidden).toBe(true);
  expect(aside.getAttribute("data-hcp-state")).toBe("off");
  expect(aside.getAttribute("data-hcp-reason")).toBe("saved");
});

test("an error card minimized and reopened from its tab is still the error card, so Download builds the live page", async () => {
  const { fetchMock } = await bootPage({ slot: "ui-error-reopen" });
  const aside = await triggerStorageError();
  aside.querySelector('[data-hcp="minimize"]').click();
  expect(aside.getAttribute("data-hcp-state")).toBe("mini");
  aside.querySelector('[data-hcp="open"]').click();
  expect(aside.getAttribute("data-hcp-state")).toBe("card");
  expect(aside.getAttribute("data-hcp-reason")).toBe("error");

  const note = document.getElementById("note");
  note.value = "typed after storage filled";
  note.setAttribute("value", "typed after storage filled");
  const { blobs } = await withDownloadStubs(() => { clickDownload(); });
  expect(blobs).toHaveLength(1);
  expect(await readBlob(blobs[0])).toContain("typed after storage filled");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the error card's download carries the live page, not the stale stored draft", async () => {
  const { fetchMock } = await bootPage({ slot: "ui-error-download" });
  const aside = await triggerStorageError();
  expect(aside.getAttribute("data-hcp-reason")).toBe("error");

  const note = document.getElementById("note");
  note.value = "typed but never stored";
  note.setAttribute("value", "typed but never stored");

  let prevented = null;
  const { blobs, downloads } = await withDownloadStubs(() => { prevented = clickDownload().defaultPrevented; });

  expect(prevented).toBe(true);
  expect(downloads).toEqual([{ href: "blob:clay-test", download: "notes.htmlclay" }]);
  expect(blobs).toHaveLength(1);
  expect(blobs[0].type).toBe("text/html");
  expect(await readBlob(blobs[0])).toContain("typed but never stored");
  expect(document.querySelector("a[download]")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the error card's download drops copy-only content the live page keeps", async () => {
  const { clay } = await bootPage({
    slot: "ui-error-download-copy",
    body: '<div id="promo" clay="no-copy">Subscribe now</div><div clay="no-copy-unless:paid-forms">Paid forms only</div>',
  });
  await triggerStorageError();

  const live = clay.getHTML();
  expect(live).toContain("Subscribe now");
  expect(live).toContain("Paid forms only");

  const { blobs } = await withDownloadStubs(() => clickDownload());
  const text = await readBlob(blobs[0]);

  expect(text).not.toContain("Subscribe now");
  expect(text).not.toContain("Paid forms only");
  expect(text).toContain("owner title");
  expect(clay.getHTML()).toBe(live);
});

test("the error card names the download after the page, index.htmlclay at the root", async () => {
  await bootPage({ slot: "ui-error-download-root", url: "/" });
  await triggerStorageError();

  const { downloads } = await withDownloadStubs(() => clickDownload());

  expect(downloads).toEqual([{ href: "blob:clay-test", download: "index.htmlclay" }]);
});

test("a download that cannot be made keeps the live page open, asks for a retry, and records nothing", async () => {
  const { key } = await bootPage({ slot: "ui-error-download-failed" });
  const aside = await triggerStorageError();

  const note = document.getElementById("note");
  note.value = "typed but never stored";
  note.setAttribute("value", "typed but never stored");

  const realCreate = URL.createObjectURL;
  const realClick = HTMLAnchorElement.prototype.click;
  const clicks = [];
  URL.createObjectURL = () => { throw new Error("no blob"); };
  HTMLAnchorElement.prototype.click = function () { clicks.push(this.href); };
  let prevented = null;
  try {
    prevented = clickDownload().defaultPrevented;
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    URL.createObjectURL = realCreate;
    HTMLAnchorElement.prototype.click = realClick;
  }

  expect(prevented).toBe(true);
  expect(clicks).toEqual([]);
  expect(localStorage.getItem(key) && JSON.parse(localStorage.getItem(key))?.prompt?.downloaded).toBeFalsy();
  expect(aside.getAttribute("data-hcp-state")).toBe("card");
  expect(aside.getAttribute("data-hcp-reason")).toBe("error");
  expect(aside.querySelector('.hcp-body [data-hcp-for="error"]').textContent).toBe(
    "The download could not be made. Keep this page open and try Download free again."
  );
  expect(document.getElementById("note").value).toBe("typed but never stored");
});

test("a template puts its own strip at the top of the body with one close button", async () => {
  const { clay } = await bootPage({ slot: "ui-intro-1", template: INTRO });

  const section = intro();
  expect(section).not.toBeNull();
  expect(section.tagName).toBe("SECTION");
  expect(document.body.firstElementChild).toBe(section);
  expect(section.getAttribute("clay")).toBe("editor-ui");
  expect(section.hasAttribute("sap-ignore")).toBe(true);
  expect(section.textContent).toContain("Track your week.");
  expect(section.querySelectorAll(".clay-intro__close").length).toBe(0);
  expect(section.querySelectorAll('clay-editor-ui[data-clay-ui="intro-close"]').length).toBe(1);
  expect(section.querySelector('clay-editor-ui[data-clay-ui="intro-close"]').shadowRoot.querySelectorAll(".clay-intro__close").length).toBe(1);

  const html = clay.getHTML();
  expect(html).not.toContain("clay-intro");
  expect(html).not.toContain("hcp");
  expect(html).not.toContain("clay-editor-ui");
  expect(html).toContain('<template visitor-intro=""><p>Track your week.</p><a href="/_/download?as=htmlclay" visitor-intro-download="">Download Notes</a></template>');
});

test("an empty or whitespace-only template mounts no intro", async () => {
  await bootPage({ slot: "ui-intro-empty", template: "<template visitor-intro></template>" });
  expect(intro()).toBeNull();

  await bootPage({ slot: "ui-intro-blank", template: "<template visitor-intro>   \n  </template>" });
  expect(intro()).toBeNull();
});

test("the close button removes the intro for good and remembers why", async () => {
  const { key } = await bootPage({ slot: "ui-intro-close", template: INTRO });

  intro().querySelector('clay-editor-ui[data-clay-ui="intro-close"]').shadowRoot.querySelector(".clay-intro__close").click();
  expect(intro()).toBeNull();
  expect(JSON.parse(localStorage.getItem(key)).intro.done).toBe("closed");

  await bootPage({ slot: "ui-intro-close", template: INTRO, keepStorage: true });
  expect(intro()).toBeNull();
});

test("an element marked visitor-intro-dismiss closes the intro the same way", async () => {
  const { key } = await bootPage({
    slot: "ui-intro-dismiss",
    template: '<template visitor-intro><p>Hello.</p><button type="button" visitor-intro-dismiss>No thanks</button></template>',
  });

  intro().querySelector("[visitor-intro-dismiss]").click();
  expect(intro()).toBeNull();
  expect(JSON.parse(localStorage.getItem(key)).intro.done).toBe("closed");
});

test("scrolling the intro past the top removes it, and a part-visible one stays", async () => {
  const { key } = await bootPage({ slot: "ui-intro-scroll", template: INTRO });
  const section = intro();
  section.getBoundingClientRect = () => ({ bottom: -1 });
  window.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  expect(intro()).toBeNull();
  expect(JSON.parse(localStorage.getItem(key)).intro.done).toBe("scrolled");

  await bootPage({ slot: "ui-intro-scroll-kept", template: INTRO });
  const kept = intro();
  kept.getBoundingClientRect = () => ({ bottom: 50 });
  window.dispatchEvent(new Event("scroll"));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(intro()).not.toBeNull();
});

test("a page that locks its own scrolling can scroll while the intro is mounted", async () => {
  await bootPage({
    slot: "ui-intro-locked",
    template: INTRO,
    head: "<style>html,body{height:100%}body{overflow:hidden}</style>",
  });

  expect(document.body.firstElementChild).toBe(intro());
  expect(styleText("clay-intro-style")).toContain(
    "html:has(> body > .clay-intro) { height: auto !important; overflow-y: auto !important; }\nbody:has(> .clay-intro) { height: auto !important; overflow: visible !important; }"
  );
});

test("the start link scrolls to the bottom edge of the intro, past a hidden svg", async () => {
  await bootPage({
    slot: "ui-intro-start",
    template: '<template visitor-intro><p>Track your week.</p><a href="#board" visitor-intro-start>Start</a></template>',
    body: "<svg hidden></svg>",
  });
  const section = intro();
  document.getElementById("title").remove();
  document.getElementById("note").remove();
  expect(section.nextElementSibling.tagName).toBe("svg");
  expect(section.nextElementSibling.hasAttribute("hidden")).toBe(true);
  section.getBoundingClientRect = () => ({ bottom: 320, height: 320 });
  const scrollTo = jest.fn();
  window.scrollTo = scrollTo;

  intro().querySelector("[visitor-intro-start]").click();

  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(scrollTo.mock.calls[0][0]).toEqual({ top: 320, behavior: "smooth" });
  expect(intro()).not.toBeNull();
});

test("the intro stands aside for a returning visitor, a draft and a deep link, and ?intro=1 forces it", async () => {
  await bootPage({ slot: "ui-intro-done", template: INTRO, ui: { v: 1, intro: { done: "closed" } } });
  expect(intro()).toBeNull();

  await bootPage({
    slot: "ui-intro-draft",
    template: INTRO,
    draft: { v: 1, savedAt: "2026-10-15T00:00:00.000Z", data: { title: "draft title", note: "typed note" } },
  });
  expect(intro()).toBeNull();

  await bootPage({ slot: "ui-intro-hash", template: INTRO, url: "/notes.html#card=c1" });
  expect(intro()).toBeNull();

  const original = window.matchMedia;
  window.matchMedia = (query) => ({ matches: query.includes("print"), media: query, addEventListener() {}, removeEventListener() {} });
  try {
    await bootPage({ slot: "ui-intro-print", template: INTRO });
    expect(intro()).toBeNull();
  } finally {
    window.matchMedia = original;
  }

  await bootPage({ slot: "ui-intro-forced", template: INTRO, url: "/notes.html?intro=1", ui: { v: 1, intro: { done: "closed" } } });
  expect(intro()).not.toBeNull();
});

test("a manual intro stays open for a returning visitor with a draft until they hide it, and stays hidden after", async () => {
  const MANUAL = '<template visitor-intro="manual"><p>Track your week.</p></template>';
  const draft = { v: 1, savedAt: "2026-10-15T00:00:00.000Z", data: { title: "draft title", note: "typed note" } };
  await bootPage({ slot: "ui-intro-manual-draft", template: MANUAL, draft });
  expect(intro()).not.toBeNull();

  const close = intro().querySelector('clay-editor-ui[data-clay-ui="intro-close"]').shadowRoot.querySelector(".clay-intro__close");
  close.click();
  expect(intro()).toBeNull();
  const ui = JSON.parse(localStorage.getItem(keyFor("ui-intro-manual-draft")));
  expect(ui.intro.done).toBe("closed");

  await bootPage({ slot: "ui-intro-manual-draft", template: MANUAL, draft, ui });
  expect(intro()).toBeNull();
});

test("the intro stands aside for the hash the page was served with, not for one the page writes", async () => {
  await bootPage({
    slot: "ui-intro-served-hash",
    template: INTRO,
    url: "/notes.html#card=c1",
    beforeBoot: () => window.history.replaceState({}, "", "/notes.html"),
  });
  expect(intro()).toBeNull();

  await bootPage({
    slot: "ui-intro-written-hash",
    template: INTRO,
    beforeBoot: () => window.history.replaceState({}, "", "/notes.html#entry=welcm1"),
  });
  expect(intro()).not.toBeNull();

  await bootPage({
    slot: "ui-intro-written-hash-forced",
    template: INTRO,
    url: "/notes.html?intro=1",
    beforeBoot: () => window.history.replaceState({}, "", "/notes.html?intro=1#entry=welcm1"),
  });
  expect(intro()).not.toBeNull();
});

test("the error card's minimize button is a boxed minus and its download controls use the download-simple icon", async () => {
  await bootPage({ slot: "ui-icons" });
  await triggerStorageError();

  const minimize = prompt().querySelector('.hcp-card .hcp-x[data-hcp="minimize"]');
  expect(minimize.querySelector("path").getAttribute("d")).toBe("M5 12h14");

  const download = "M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z";
  expect(prompt().querySelector("[data-hcp-link] svg path").getAttribute("d")).toBe(download);
  expect(prompt().querySelector(".hcp-tab svg path").getAttribute("d")).toBe(download);
  expect(prompt().querySelector(".hcp-file svg path").getAttribute("d")).toBe(download);
});

test("the owner sees an explicit owner-only note naming which lane they are in", async () => {
  await bootPage({ slot: "ui-owner-1", owner: true, url: "/notes.html?editmode=true" });
  expect(ownerChip()).not.toBeNull();
  expect(ownerChip().getAttribute("clay")).toBe("editor-ui");
  expect(ownerChip().hasAttribute("sap-ignore")).toBe(true);
  expect(ownerChip().querySelector(".clay-owner__lead").textContent).toBe("Owner only (visitors don't see this): you're editing the live original.");
  expect(ownerChip().querySelector(".clay-owner__action").textContent).toBe("Back to my draft");

  await bootPage({ slot: "ui-owner-2", owner: true, template: INTRO });
  expect(ownerChip().querySelector(".clay-owner__lead").textContent).toBe("Owner only (visitors don't see this): you're in a private draft.");
  expect(ownerChip().querySelector(".clay-owner__action").textContent).toBe("Edit the original");

  await bootPage({ slot: "ui-owner-3", template: INTRO });
  expect(hostOf("owner")).toBeNull();

  await bootPage({ slot: "ui-owner-4", params: "plugins=undo&exclude=richclay,source", owner: true });
  expect(hostOf("owner")).toBeNull();
});

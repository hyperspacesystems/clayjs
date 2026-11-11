/**
 * A visitor's draft record on a page document: the record keeps every live store's
 * value and the article the save projected, restore writes those values back into the
 * store tags, and two tabs that both changed the page are kept apart.
 */
import { jest } from "@jest/globals";
import { createStore, draftKey } from "../../src/plugins/visitor-drafts/store.js";

const SLOT = "t1";
const KEY = draftKey(SLOT, "/");
const SAVED_AT = "2026-10-15T12:00:00.000Z";

const RULES = '{"title":"h1"}';
const SETTINGS = '<script type="application/json" merge="blockeditor.settings" clay="live">{}</script>';
const PAGE = { v: 1, y: "AAA" };

const rulesTag = (rules) => `<script type="application/json" data-rules-name="api" data-rules-version="1">${rules}</script>`;

function setPage({ rules = RULES, rev = "r0", article = "<p>served</p>", withArticle = true, page = null } = {}) {
  document.documentElement.setAttribute("visitor-drafts", SLOT);
  document.head.innerHTML = rulesTag(rules) + SETTINGS;
  document.body.innerHTML = `<h1>T</h1>${page ? `<script type="application/json" merge="blockeditor" clay="live">${JSON.stringify(page)}</script>` : ""}${withArticle ? `<article class="blockeditor" clay="freeze" data-blockeditor="1" data-rev="${rev}">${article}</article>` : ""}`;
}

function savedBytes({ rules = RULES, rev = "r1", article = "<p>typed</p>", withArticle = true, title = "T", page = PAGE } = {}) {
  const articleHtml = withArticle ? `<script type="application/json" merge="blockeditor" clay="live">${JSON.stringify(page)}</script><article class="blockeditor" clay="freeze" data-blockeditor="1" data-rev="${rev}">${article}</article>` : "";
  return `<!DOCTYPE html><html visitor-drafts="${SLOT}"><head>${rulesTag(rules)}${SETTINGS}</head><body><h1>${title}</h1>${articleHtml}</body></html>`;
}

const blockeditorRecord = ({ id = "a", rev = "r1", title = "owner", value = PAGE } = {}) => JSON.stringify({
  v: 1,
  savedAt: SAVED_AT,
  id,
  ancestry: [],
  data: { title },
  live: { blockeditor: value, "blockeditor.settings": {} },
  blockeditor: { rev, html: `<p>${rev}</p>` },
});

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (name) => (map.has(name) ? map.get(name) : null),
    setItem: (name, value) => { map.set(name, String(value)); },
    removeItem: (name) => { map.delete(name); },
    keys: () => [...map.keys()],
  };
}

function collect(name) {
  const seen = [];
  const listener = (event) => seen.push(event.detail);
  document.addEventListener(name, listener);
  return { seen, stop: () => document.removeEventListener(name, listener) };
}

const now = () => new Date(SAVED_AT);
const article = () => document.querySelector("article[data-blockeditor]");

afterEach(() => {
  jest.restoreAllMocks();
});

test("a blockeditor-only change writes a record holding the page", () => {
  setPage({ rules: "{}" });
  const storage = fakeStorage();
  const store = createStore({ doc: document, storage, now });

  store.write(savedBytes({ rules: "{}" }));

  const record = JSON.parse(storage.getItem(KEY));
  expect(record.data).toEqual({});
  expect(record.live.blockeditor).toEqual({ v: 1, y: "AAA" });
  expect(record.blockeditor.rev).toBe("r1");
  expect(record.blockeditor.html).toContain("typed");
});

test("an untouched page writes no record", () => {
  setPage();
  const storage = fakeStorage();
  const saved = collect("clay:drafts-saved");
  const store = createStore({ doc: document, storage, now });

  store.restore();
  store.write(savedBytes({ rev: "r0" }));

  expect(storage.getItem(KEY)).toBeNull();
  expect(saved.seen.length).toBe(1);
  expect(saved.seen[0].unchanged).toBe(true);
  saved.stop();
});

test("restore puts the stored page into the store tags before the article", () => {
  setPage();
  const storage = fakeStorage({ [KEY]: blockeditorRecord({ rev: "r1" }) });
  const store = createStore({ doc: document, storage, now });

  const result = store.restore();

  expect(result.restored).toBe(true);
  const tag = article().previousElementSibling;
  expect(tag.getAttribute("merge")).toBe("blockeditor");
  expect(tag.getAttribute("clay")).toContain("live");
  expect(JSON.parse(tag.textContent)).toEqual(PAGE);
  expect(article().textContent).toContain("served");
  expect(article().getAttribute("data-rev")).toBe("r0");
  expect(JSON.parse(document.querySelector('script[merge="blockeditor.settings"]').textContent)).toEqual({});
});

test("a stored value cannot close its tag", () => {
  setPage();
  const value = "</script><script>x()</script>";
  const storage = fakeStorage({ [KEY]: blockeditorRecord({ rev: "r1", value }) });
  const scripts = document.querySelectorAll("script").length;
  const store = createStore({ doc: document, storage, now });

  const result = store.restore();

  expect(result.restored).toBe(true);
  expect(document.querySelectorAll("script").length).toBe(scripts + 1);
  const tag = article().previousElementSibling;
  expect(tag.getAttribute("merge")).toBe("blockeditor");
  expect(tag.textContent).not.toContain("</script");
  expect(tag.textContent).toContain("\\u003c");
  expect(JSON.parse(tag.textContent)).toBe(value);
  expect(document.querySelectorAll("script").length).toBe(scripts + 1);
});

test("a page record with no article to go into is kept aside", () => {
  setPage({ withArticle: false });
  const raw = blockeditorRecord({ rev: "r1" });
  const storage = fakeStorage({ [KEY]: raw });
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const store = createStore({ doc: document, storage, now });

  let result = null;
  expect(() => { result = store.restore(); }).not.toThrow();

  expect(result.hadDraft).toBe(true);
  expect(storage.keys()).toContain(KEY + ":unreadable:" + SAVED_AT);
  expect(storage.getItem(KEY + ":unreadable:" + SAVED_AT)).toBe(raw);
});

test("a page record from another tab is kept when this tab's page did not change", () => {
  setPage();
  const recordA = blockeditorRecord({ id: "a", rev: "r1" });
  const storage = fakeStorage({ [KEY]: recordA });
  const store = createStore({ doc: document, storage, now });
  expect(store.restore().restored).toBe(true);
  const recordB = blockeditorRecord({ id: "b", rev: "r2", title: "owner" });
  storage.setItem(KEY, recordB);

  store.write(savedBytes({ rev: "r1", title: "Typed" }));

  const stored = JSON.parse(storage.getItem(KEY));
  expect(stored.blockeditor.rev).toBe("r2");
  expect(stored.blockeditor.html).toContain("r2");
  expect(stored.live.blockeditor).toEqual(PAGE);
  expect(stored.data.title).toBe("Typed");
  expect(storage.getItem(KEY + ":conflict")).toBeNull();
});

test("both tabs changed the page: mine is written and theirs is kept aside", () => {
  setPage();
  const recordA = blockeditorRecord({ id: "a", rev: "r1" });
  const storage = fakeStorage({ [KEY]: recordA });
  const store = createStore({ doc: document, storage, now });
  expect(store.restore().restored).toBe(true);
  const recordB = blockeditorRecord({ id: "b", rev: "r2", title: "owner" });
  storage.setItem(KEY, recordB);
  jest.spyOn(console, "warn").mockImplementation(() => {});

  store.write(savedBytes({ rev: "r3", title: "Typed", article: "<p>mine</p>" }));

  const stored = JSON.parse(storage.getItem(KEY));
  expect(stored.blockeditor.rev).toBe("r3");
  expect(stored.blockeditor.html).toContain("mine");
  expect(storage.getItem(KEY + ":conflict")).toBe(recordB);
});

test("externalUnit names a page another tab recorded, and adoptedUnit makes it this tab's", () => {
  setPage();
  const recordA = blockeditorRecord({ id: "a", rev: "r1" });
  const storage = fakeStorage({ [KEY]: recordA });
  const store = createStore({ doc: document, storage, now });
  expect(store.restore().restored).toBe(true);
  const recordB = blockeditorRecord({ id: "b", rev: "r2", title: "owner" });
  storage.setItem(KEY, recordB);

  expect(store.externalUnit().blockeditor.rev).toBe("r2");
  store.adoptedUnit(store.externalUnit());
  expect(store.externalUnit()).toBeNull();

  store.write(savedBytes({ rev: "r3", title: "Typed", article: "<p>mine</p>" }));

  const stored = JSON.parse(storage.getItem(KEY));
  expect(stored.blockeditor.rev).toBe("r3");
  expect(stored.blockeditor.html).toContain("mine");
  expect(storage.getItem(KEY + ":conflict")).toBeNull();
});

test("a Journal record is unchanged", () => {
  setPage({ withArticle: false });
  const storage = fakeStorage();
  const store = createStore({ doc: document, storage, now });
  store.restore();

  store.write(savedBytes({ withArticle: false, title: "Typed" }));

  const stored = JSON.parse(storage.getItem(KEY));
  expect(Object.keys(stored).sort()).toEqual(["ancestry", "data", "id", "savedAt", "v"]);
  expect(stored.data).toEqual({ title: "Typed" });
  expect(stored.v).toBe(1);
  expect(article()).toBeNull();
});

test("a page cleared back to the served text still reaches the other tab", () => {
  setPage({ page: PAGE });
  const storage = fakeStorage({ [KEY]: blockeditorRecord({ id: "a", rev: "r1" }) });
  const store = createStore({ doc: document, storage, now });
  expect(store.restore().restored).toBe(true);

  store.write(savedBytes({ rev: "r0", page: PAGE }));

  const record = JSON.parse(storage.getItem(KEY));
  expect(record.blockeditor).toBeTruthy();
  expect(record.blockeditor.rev).toBe("r0");
});

test("a data-only save leaves the other tab's page unseen", () => {
  setPage();
  const storage = fakeStorage({ [KEY]: blockeditorRecord({ id: "a", rev: "r1" }) });
  const store = createStore({ doc: document, storage, now });
  expect(store.restore().restored).toBe(true);
  storage.setItem(KEY, blockeditorRecord({ id: "b", rev: "r2" }));

  store.write(savedBytes({ rev: "r1", title: "Typed" }));
  expect(JSON.parse(storage.getItem(KEY)).blockeditor.rev).toBe("r2");

  jest.spyOn(console, "warn").mockImplementation(() => {});
  store.write(savedBytes({ rev: "r3", title: "Typed", article: "<p>mine</p>" }));

  const conflict = JSON.parse(storage.getItem(KEY + ":conflict"));
  expect(conflict.blockeditor.rev).toBe("r2");
  expect(JSON.parse(storage.getItem(KEY)).blockeditor.rev).toBe("r3");
});

test("a page is placed even when no saved field fits the rules", () => {
  setPage({ rules: '{"heading":"h1"}', rev: "r1", article: "<h1>served</h1>", page: PAGE });
  const raw = blockeditorRecord({ title: "x", rev: "r1" });
  const storage = fakeStorage({ [KEY]: raw });
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const store = createStore({ doc: document, storage, now });

  const result = store.restore();

  expect(result.restored).toBe(true);
  expect(result.partial).toBe(true);
  const tag = article().previousElementSibling;
  expect(tag.getAttribute("merge")).toBe("blockeditor");
  expect(JSON.parse(tag.textContent)).toEqual(PAGE);
  expect(storage.getItem(KEY)).toBe(raw);
  expect(storage.keys().filter((name) => name.startsWith(KEY + ":unreadable:"))).toEqual([KEY + ":unreadable:" + SAVED_AT]);
});

/**
 * Step 4 of the one-transaction drafts (05b) through the real loader: a page load without
 * the database and the load that follows it, a save from a tab on a released ClayJS, a
 * copy that cannot be merged, and a download that waits for the database to hold the
 * page's last changes.
 */
import { afterEach, expect, jest, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, B, bootPage, cacheOf, failingFactory, headFor, keyFor, noDatabase, pause, readIdb, seedIdb, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

const title = () => document.getElementById("title").textContent;
const note = () => document.getElementById("note").value;
const recoveryRows = (all) => [...all.keys()].filter((name) => name.includes(":recovery:"));
const notices = () => [...(document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot?.querySelectorAll("[data-clay-toast]") ?? [])].map((el) => el.textContent).filter((text) => text.includes("kept aside"));
const promptRoot = () => document.querySelector('clay-editor-ui[data-clay-ui="download-prompt"]')?.shadowRoot?.getElementById("hcp") ?? null;

// Every click that reaches the document from the download prompt: whether the prompt held
// it back, and what `seen` reads at that moment. The navigation itself never runs here.
function watchDownload(seen) {
  const clicks = [];
  const onClick = (event) => {
    if (!event.composedPath().some((node) => node.getAttribute?.("data-hcp-link") !== null && node.getAttribute?.("data-hcp-link") !== undefined)) return;
    clicks.push({ held: event.defaultPrevented, ...seen() });
    event.preventDefault();
  };
  document.addEventListener("click", onClick);
  return { clicks, stop: () => document.removeEventListener("click", onClick) };
}

test("a page load without the database writes localStorage as a released ClayJS does, and the next load takes it in exactly", async () => {
  const factory = new IDBFactory();
  const slot = "old-roundtrip-1";
  const key = keyFor(slot);
  await seedIdb(factory, key, { record: A, meta: { rev: 3 } });

  noDatabase();
  const offline = await bootPage({ slot, localRaw: cacheOf(A, { rev: 3, reset: "" }) });
  expect([title(), note()]).toEqual(["title A", "note A"]);
  type("typed without the database");
  expect((await offline.clay.save()).ok).toBe(true);
  const written = JSON.parse(offline.local());
  expect(written.w).toBe(undefined);
  expect(written.ancestry[0]).toBe(A.id);
  expect(offline.slots()).toEqual([]);

  useFactory(factory);
  const next = await bootPage({ slot, keep: true });
  expect(note()).toBe("typed without the database");
  await waitFor(async () => (await readIdb(factory, key)).record?.data.note === "typed without the database", "the record in the database");
  const { record, meta, all } = await readIdb(factory, key);
  expect(record.data).toEqual({ ...A.data, note: "typed without the database" });
  expect(record.ancestry.slice(0, 2)).toEqual([written.id, A.id]);
  expect(meta.foreign).toBe(written.id);
  expect(recoveryRows(all)).toEqual([]);
  await waitFor(() => JSON.parse(next.local()).w !== undefined, "the cache");
  expect(JSON.parse(next.local())).toEqual({ ...record, w: { rev: meta.rev, reset: "" } });
  expect(notices()).toEqual([]);
  expect(next.clay.hasUnsavedChanges()).toBe(false);
});

test("a save from a tab on a released ClayJS reaches a page with nothing unsaved, and the cache follows it", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const { clay, key, local } = await bootPage({ slot: "old-save-1" });
  type("first");
  expect((await clay.save()).ok).toBe(true);
  const cache = local();
  const held = JSON.parse(cache);
  const child = { v: 1, savedAt: "2026-11-12T13:00:00.000Z", id: "oldchild0001", ancestry: [held.id, ...held.ancestry], data: { ...held.data, title: "old tab title" } };
  localStorage.setItem(key, JSON.stringify(child));
  window.dispatchEvent(new StorageEvent("storage", { key, oldValue: cache, newValue: JSON.stringify(child) }));

  await waitFor(() => title() === "old tab title", "the old tab's title on the page");
  const { record, meta, all } = await readIdb(factory, key);
  expect(record.data).toMatchObject({ title: "old tab title", note: "first" });
  expect(record.ancestry.slice(0, 2)).toEqual(["oldchild0001", held.id]);
  expect(recoveryRows(all)).toEqual([]);
  await waitFor(() => JSON.parse(local()).w !== undefined, "the cache");
  expect(JSON.parse(local())).toEqual({ ...record, w: { rev: meta.rev, reset: "" } });
  expect(clay.hasUnsavedChanges()).toBe(false);
});

test("a copy that cannot be merged is kept aside at boot: the page ends on the stored draft and the visitor is told", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const slot = "old-aside-1";
  const key = keyFor(slot);
  await seedIdb(factory, key, { record: B, meta: { rev: 4 } });
  const page = { v: 1, savedAt: "2026-11-12T13:00:00.000Z", id: "oldpage00001", ancestry: ["root:"], data: { title: "owner title", note: "typed in the old tab", rows: [] } };
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { clay, events, local } = await bootPage({ slot, localRaw: JSON.stringify(page) });
    expect(note()).toBe("typed in the old tab");
    await waitFor(() => note() === "note B", "the stored draft on the page");
    expect(title()).toBe("title B");
    expect(document.querySelectorAll("#rows > li[item]:not([cms-template])").length).toBe(1);
    const { record, meta, all } = await readIdb(factory, key);
    expect(record).toEqual(B);
    expect(recoveryRows(all)).toEqual([`${key}:recovery:oldpage00001`]);
    expect(JSON.parse(all.get(`${key}:recovery:oldpage00001`))).toEqual(page);
    expect(meta).toMatchObject({ rev: 4, foreign: "oldpage00001", recovery: ["oldpage00001"] });
    await waitFor(() => notices().length === 1, "the notice");
    await waitFor(() => JSON.parse(local()).w !== undefined, "the cache");
    expect(JSON.parse(local())).toEqual({ ...B, w: { rev: 4, reset: "" } });
    expect(events.filter((event) => event.name === "clay:drafts-restored").map((event) => Boolean(event.detail.external))).toEqual([false, true]);
    expect(clay.hasUnsavedChanges()).toBe(false);
    expect(warn.mock.calls.filter(([text]) => String(text).includes("could not be merged exactly")).length).toBe(1);
  } finally {
    warn.mockRestore();
  }
});

test("download() waits until the database holds what was typed, then follows the link once", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const { clay, key, local, slots } = await bootPage({ slot: "old-download-1" });
  await pause();
  const watch = watchDownload(() => ({ slots: slots().length, cached: JSON.parse(local() ?? "null")?.data.note ?? null }));
  try {
    type("typed right before the download");
    expect(slots()).toEqual([]);
    await clay.visitorDrafts.download();
  } finally {
    watch.stop();
  }
  expect(watch.clicks).toEqual([{ held: false, slots: 0, cached: "typed right before the download" }]);
  expect((await readIdb(factory, key)).record.data.note).toBe("typed right before the download");
});

test("a click on the download link is held until the database has what was typed, and goes straight through when it already has", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const { clay, key, local, slots } = await bootPage({ slot: "old-download-2" });
  await waitFor(() => promptRoot() !== null, "the download prompt");
  await clay.visitorDrafts.ready;
  const link = promptRoot().querySelector("[data-hcp-link]");
  const watch = watchDownload(() => ({ slots: slots().length, cached: JSON.parse(local() ?? "null")?.data.note ?? null }));
  try {
    type("typed, then the link at once");
    link.click();
    expect(watch.clicks).toEqual([{ held: true, slots: 1, cached: null }]);
    await waitFor(() => watch.clicks.length === 2, "the link to be followed");
    expect(watch.clicks[1]).toEqual({ held: false, slots: 0, cached: "typed, then the link at once" });
    expect((await readIdb(factory, key)).record.data.note).toBe("typed, then the link at once");

    link.click();
    await pause();
    expect(watch.clicks.length).toBe(3);
    expect(watch.clicks[2].held).toBe(false);
  } finally {
    watch.stop();
  }
});

test("when the database refuses the write, the download is the rescue download of the page, not the link", async () => {
  const base = new IDBFactory();
  const { factory, state } = failingFactory(base);
  useFactory(factory);
  const { clay, slots } = await bootPage({ slot: "old-download-3" });
  await waitFor(() => promptRoot() !== null, "the download prompt");
  await clay.visitorDrafts.ready;
  await pause();
  const watch = watchDownload(() => ({ reason: promptRoot().getAttribute("data-hcp-reason") }));
  try {
    state.fail = true;
    type("typed while the database refuses");
    await clay.visitorDrafts.download();
    await pause();
  } finally {
    watch.stop();
    state.fail = false;
  }
  expect(watch.clicks).toEqual([{ held: true, reason: "error" }]);
  expect(slots().length).toBe(1);
});

test("a page whose draft is held where it cannot be read still answers download(), and writes nothing", async () => {
  useFactory({ open: () => { throw new Error("no database"); } });
  const raw = headFor(B);
  const { clay, local } = await bootPage({ slot: "old-download-4", localRaw: raw });
  const watch = watchDownload(() => ({}));
  let problem = null;
  try {
    type("typed over nothing");
    try { await clay.visitorDrafts.download(); } catch (error) { problem = `${error.name}: ${error.message}`; }
  } finally {
    watch.stop();
  }
  expect(problem).toBe(null);
  expect(watch.clicks.length).toBe(1);
  expect(local()).toBe(raw);
});

test("without the database, download() writes the page to localStorage before it follows the link", async () => {
  noDatabase();
  const { clay, local } = await bootPage({ slot: "old-download-5" });
  const watch = watchDownload(() => ({ stored: JSON.parse(local() ?? "null")?.data.note ?? null }));
  try {
    type("typed without the database, then download");
    await clay.visitorDrafts.download();
  } finally {
    watch.stop();
  }
  expect(watch.clicks).toEqual([{ held: false, stored: "typed without the database, then download" }]);
});

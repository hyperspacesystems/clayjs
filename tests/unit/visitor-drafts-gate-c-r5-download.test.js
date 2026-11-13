import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, bootPage, cacheOf, noDatabase, pause, readIdb, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

async function holdDatabase(factory, key) {
  const db = await new Promise((resolve, reject) => {
    const req = factory.open("clay-visitor-drafts", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  let release = false;
  const tx = db.transaction("records", "readwrite");
  const store = tx.objectStore("records");
  function hold() { store.get(key).onsuccess = () => { if (!release) hold(); }; }
  hold();
  const completed = new Promise((resolve) => { tx.oncomplete = resolve; });
  return async () => { release = true; await completed; db.close(); };
}

const promptRoot = () => document.querySelector('clay-editor-ui[data-clay-ui="download-prompt"]')?.shadowRoot?.getElementById("hcp");
const blobText = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsText(blob);
});

for (const entry of ["link", "API"]) {
  test(`${entry} download timeout exports the current page while the database still holds the older draft`, async () => {
    const factory = new IDBFactory();
    useFactory(factory);
    const { clay, key, slots } = await bootPage({ slot: `r5-download-${entry}` });
    type("saved before download");
    expect((await clay.save()).ok).toBe(true);
    await waitFor(() => promptRoot(), "prompt");
    const link = promptRoot().querySelector("[data-hcp-link]");
    const release = await holdDatabase(factory, key);
    const clicks = [];
    const downloads = [];
    const blobs = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => { blobs.push(blob); return "blob:r5-current-page"; };
    URL.revokeObjectURL = () => {};
    const watch = (event) => {
      if (event.composedPath().includes(link)) clicks.push(event.defaultPrevented);
      else if (event.target.matches?.("a[download]")) downloads.push(event.target.download);
      event.preventDefault();
    };
    document.addEventListener("click", watch);
    try {
      type("typed just before download");
      const started = Date.now();
      if (entry === "API") await clay.visitorDrafts.download();
      else link.click();
      await waitFor(() => downloads.length > 0 || clicks.includes(false), "download outcome", 4500);
      expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
      expect(clicks).toEqual([true]);
      expect(downloads).toEqual(["notes.htmlclay"]);
      expect(blobs).toHaveLength(1);
      expect(await blobText(blobs[0])).toContain('value="typed just before download"');
      expect(JSON.parse(localStorage.getItem(key)).data.note).toBe("saved before download");
      expect(slots()).toHaveLength(1);
    } finally {
      await release();
      await pause();
      document.removeEventListener("click", watch);
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
    expect((await readIdb(factory, key)).record.data.note).toBe("typed just before download");
  }, 10000);
}

test.each([false, true])("typing during the download wait is committed before following the link (parked: %s)", async (parked) => {
  const factory = new IDBFactory();
  useFactory(factory);
  const localRaw = parked ? cacheOf({ ...A, data: { removedField: "kept aside" } }) : null;
  const { clay, key } = await bootPage({ slot: "r5-download-more-typing-" + parked, localRaw });
  if (parked) expect(clay.visitorDrafts.restored()).toMatchObject({ restored: false, parked: true });
  type("saved first");
  await clay.save();
  await waitFor(() => promptRoot(), "prompt");
  const link = promptRoot().querySelector("[data-hcp-link]");
  const release = await holdDatabase(factory, key);
  const left = [];
  const watch = (event) => {
    if (event.composedPath().includes(link) && !event.defaultPrevented) left.push(JSON.parse(localStorage.getItem(key)).data.note);
    event.preventDefault();
  };
  document.addEventListener("click", watch);
  try {
    type("before clicking");
    link.click();
    type("typed while waiting");
    await release();
    await waitFor(() => left.length > 0, "link navigation");
    expect(left).toEqual(["typed while waiting"]);
  } finally { document.removeEventListener("click", watch); }
});

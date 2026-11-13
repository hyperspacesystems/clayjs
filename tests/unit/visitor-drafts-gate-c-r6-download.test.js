import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, big, bootPage, failingFactory, headFor, keyFor, noDatabase, pause, readIdb, seedIdb, slowFactory, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

for (const failure of ["open", "transaction"]) {
  test(`a large draft refused at ${failure} shows its error immediately and both download entries follow the download page`, async () => {
    const real = new IDBFactory();
    const slot = "r6-download-refused-" + failure;
    const key = keyFor(slot);
    const record = { ...A, data: { ...A.data, note: big("R") } };
    await seedIdb(real, key, { record });
    const broken = failure === "open" ? slowFactory(real, 10, { fail: true }) : failingFactory(real);
    broken.state.fail = true;
    useFactory(broken.factory);
    const raw = headFor(record);
    const page = await bootPage({ slot, localRaw: raw });
    const { ready } = await import("../../src/plugins/visitor-drafts.js");
    const prompt = await ready;
    expect(page.clay.visitorDrafts.restored()).toMatchObject({ restored: false, hadDraft: true, blocked: true });
    expect(document.getElementById("note").value).toBe("owner note");
    expect(prompt.root.hidden).toBe(false);
    expect(prompt.root.getAttribute("data-hcp-state")).toBe("card");
    expect(prompt.root.getAttribute("data-hcp-reason")).toBe("error");
    const link = prompt.root.querySelector("[data-hcp-link]");
    expect(link.href).toBe(new URL(page.clay.visitorDrafts.downloadUrl(), location.href).href);
    const clicks = [];
    const blobs = [];
    const downloads = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => { blobs.push(blob); return "blob:r6-refused"; };
    URL.revokeObjectURL = () => {};
    const watch = (event) => {
      if (event.composedPath().includes(link)) clicks.push(event.defaultPrevented);
      else if (event.target.matches?.("a[download]")) downloads.push(event.target.download);
      event.preventDefault();
    };
    document.addEventListener("click", watch);
    try {
      link.click();
      await page.clay.visitorDrafts.download();
      await pause();
      expect(clicks).toEqual([false, false]);
      expect(blobs).toEqual([]);
      expect(downloads).toEqual([]);
      expect(page.local()).toBe(raw);
      expect((await readIdb(real, key)).record).toEqual(record);
    } finally {
      document.removeEventListener("click", watch);
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
}

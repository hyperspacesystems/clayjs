import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, big, bootPage, headFor, keyFor, noDatabase, readIdb, seedIdb, slowFactory, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

for (const entry of ["transport", "save"]) {
  test(`${entry} requested during a large restore captures the restored page`, async () => {
    const real = new IDBFactory();
    const slot = `r5-restore-${entry}`;
    const key = keyFor(slot);
    const record = { ...A, data: { ...A.data, note: big("R") } };
    await seedIdb(real, key, { record });
    const { factory, state } = slowFactory(real, 400);
    useFactory(factory);
    const booting = bootPage({ slot, localRaw: headFor(record) });
    await waitFor(async () => {
      const { draftTransport } = await import("../../src/core/draft-mode.js");
      return draftTransport() !== null;
    }, "draft transport");
    expect(state.opened).toBe(false);
    expect(document.getElementById("note").value).toBe("owner note");
    const { draftTransport } = await import("../../src/core/draft-mode.js");
    const { getPageContents, saveHtml } = await import("../../src/core/save-core.js");
    const beforeRestore = getPageContents();
    const saving = entry === "transport" ? draftTransport()(beforeRestore) : saveHtml(beforeRestore);
    await booting;
    const saved = await saving;
    if (entry === "save") expect(saved.ok).toBe(true);
    const after = await readIdb(real, key);
    expect(after.record.data).toEqual(record.data);
    expect(after.conflict).toBe(null);
    expect(after.meta.rev).toBe(1);
    expect(document.getElementById("note").value).toBe(record.data.note);
  });
}

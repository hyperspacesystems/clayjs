import {
  captureForSave,
  captureForSaveAndComparison,
} from "../../src/core/snapshot.js";

beforeEach(() => {
  document.body.innerHTML = `
    <div id="keep">KEEPME</div>
    <nav clay="no-save">NOSAVEREGION</nav>
    <aside save-remove>LEGACYREMOVE</aside>
    <span clay="no-snapshot">NOSNAPREGION</span>
    <p onbeforesave="this.textContent='CHANGED'">beforetext</p>
    <grammarly-extension>EXTNOISE</grammarly-extension>
  `;
});

test("strips no-save (clay + legacy), no-snapshot, and extension noise; keeps content; runs onbeforesave", () => {
  const forSave = captureForSave({ emitForSync: false });

  expect(forSave).toContain("KEEPME");
  expect(forSave).not.toContain("NOSAVEREGION");
  expect(forSave).not.toContain("LEGACYREMOVE");
  expect(forSave).not.toContain("NOSNAPREGION");
  expect(forSave).not.toContain("EXTNOISE");
  expect(forSave).toContain("CHANGED");
  expect(forSave).not.toContain("beforetext");
});

test("the global the snapshot used to live on is gone", () => {
  captureForSaveAndComparison();
  expect(window.__hyperclaySnapshotHtml).toBeUndefined();
});

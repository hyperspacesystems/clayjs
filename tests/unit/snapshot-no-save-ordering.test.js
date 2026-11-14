import {
  captureForSave,
  captureForSaveAndComparison,
  addDocumentTransform,
  onSnapshot,
} from "../../src/core/snapshot.js";

// Regression for snapshot-algorithm step 7: save-time hooks run BEFORE the
// [no-save] strip. The real [freeze]/[save-freeze] restore hook re-injects an
// element's original innerHTML into the clone AFTER capture; if that original
// contained a [no-save] element and the strip ran first, the content would leak
// to disk. Here a stand-in hook re-injects a [no-save] element after capture and
// the saved document must not contain it.
addDocumentTransform((clone) => {
  const body = clone.querySelector("body");
  if (!body) return;
  const leak = document.createElement("div");
  leak.setAttribute("no-save", "");
  leak.textContent = "HOOKINJECTEDNOSAVE";
  body.appendChild(leak);
});

beforeEach(() => {
  document.body.innerHTML = `<div id="keep">KEEPME</div>`;
  window.__hyperclaySnapshotHtml = null;
});

test("captureForSave strips a [no-save] element a prepare hook injected after capture", () => {
  const forSave = captureForSave({ emitForSync: false });
  expect(forSave).toContain("KEEPME");
  expect(forSave).not.toContain("HOOKINJECTEDNOSAVE");
});

test("captureForSaveAndComparison strips hook-injected [no-save] from the saved document", () => {
  const { forSave } = captureForSaveAndComparison({ emitForSync: false });
  expect(forSave).toContain("KEEPME");
  expect(forSave).not.toContain("HOOKINJECTEDNOSAVE");
});

// A registered callback is page code the capture runs, so a throw in one is that hook's
// loss, never the save's. The report is once per hook, not once per autosave.
test("a throwing registered hook is skipped once and reported once, and the capture goes on", () => {
  const realError = console.error;
  let reports = 0;
  console.error = () => { reports += 1; };
  try {
    onSnapshot(() => { throw new Error("broken snapshot hook"); });
    addDocumentTransform(() => { throw new Error("broken document transform"); });
    addDocumentTransform((clone) => {
      const body = clone.querySelector("body");
      const mark = document.createElement("div");
      mark.textContent = "GOODHOOKMARK";
      body?.appendChild(mark);
    });

    const first = captureForSave({ emitForSync: false });
    const second = captureForSave({ emitForSync: false });

    expect(first).toContain("GOODHOOKMARK");
    expect(second).toContain("GOODHOOKMARK");
    expect(reports).toBe(2);
  } finally {
    console.error = realError;
  }
});

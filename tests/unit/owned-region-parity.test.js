import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GOLDEN = fileURLToPath(new URL("../fixtures/owned-region-parity.json", import.meta.url));

const PAGES = {
  plain: `<main><h1 contenteditable>Title</h1><p>one &amp; two</p><input value="typed"><textarea>area</textarea><select><option>a</option><option selected>b</option></select></main>`,
  policies: `<section data-id="a"><p>kept</p></section><aside no-save>chrome</aside><div clay="no-trigger-autosave"><p>draft</p></div><div clay="no-watch"><p>churn</p></div><div clay="no-dirty"><p>scratch</p></div><div freeze><p>frozen</p></div><div no-snapshot>gone</div>`,
  structure: `<noscript><p>off</p></noscript><template><li><b>row</b></li></template><div style="" class=""><span style="color:red">x</span></div>`,
  sheet: `<section item data-id="tab-1"><table grid data-id="g"><tbody><tr><td n>1</td><td f="=A1*2" n v="2">2</td></tr></tbody></table></section><section item data-id="tab-2"><table grid><tbody><tr><td t>x</td></tr></tbody></table></section>`,
};

function drain(generator) {
  let step = generator.next();
  while (!step.done) step = generator.next();
  return step.value;
}

let snapshot;
let steps;
let saveJob;

beforeAll(async () => {
  window.clayEditMode = true;
  snapshot = await import("../../src/core/snapshot.js");
  steps = await import("../../src/core/serialize-steps.js");
  saveJob = await import("../../src/core/save-job.js");
});

function everyOutput() {
  const save = snapshot.captureForSaveAndComparison({ emitForSync: false });
  const both = snapshot.captureForComparisonAndDirty();
  const clone = snapshot.captureSnapshot({ flushUndo: false });
  const sliced = drain(saveJob.beginSaveCapture({ emitForSync: false }).steps());
  const merge = snapshot.captureForMerge();
  return {
    forSave: save.forSave, forComparison: save.forComparison, forDirty: save.forDirty,
    comparison: snapshot.captureForComparison(), dirty: snapshot.captureForDirtyCheck(),
    bothComparison: both.forComparison, bothDirty: both.forDirty,
    sync: snapshot.serializeForSync(clone), syncSteps: drain(steps.serializeForSyncSteps(snapshot.copyCaptureClone(clone))),
    page: snapshot.getPageContents(), recovery: snapshot.captureRecoveryPage(),
    recoveryClone: snapshot.serializeRecoveryClone(clone), captureForSave: snapshot.captureForSave({ emitForSync: false }),
    slicedSave: sliced.forSave, slicedComparison: sliced.forComparison, slicedDirty: sliced.forDirty,
    mergeSave: snapshot.serializeClone(merge.saveClone), mergeCompare: merge.compareClone.outerHTML,
  };
}

test("a document with no owned region writes the bytes main wrote before owned regions existed", () => {
  const now = {};
  for (const [name, body] of Object.entries(PAGES)) {
    document.body.innerHTML = body;
    now[name] = everyOutput();
  }
  if (process.env.UPDATE_GOLDENS === "1") writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + "\n");
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  expect(Object.keys(golden)).toEqual(Object.keys(PAGES));
  for (const name of Object.keys(PAGES)) {
    expect(Object.keys(now[name]).length).toBe(18);
    for (const key of Object.keys(golden[name])) expect([name, key, now[name][key]]).toEqual([name, key, golden[name][key]]);
  }
  expect(golden.sheet.forSave).toContain('<td f="=A1*2" n="" v="2">2</td>');
});

import { jest } from "@jest/globals";

let snapshot;
let regions;
let steps;

const SHEET = `
  <header><h1 contenteditable>Budget</h1><input value="typed"></header>
  <section item data-id="tab-1"><table grid data-id="grid-1"><tbody><tr><td n>1</td><td f="=A1*2" n>2</td></tr></tbody></table></section>
  <section item data-id="tab-2"><table grid><tbody><tr><td>x</td></tr></tbody></table></section>
  <aside no-save>chrome</aside>
  <div clay="no-trigger-autosave"><p>draft</p></div>
  <noscript><p>off</p></noscript>`;

function drain(generator) {
  let step = generator.next();
  while (!step.done) step = generator.next();
  return step.value;
}

function owner() {
  const state = { serialize: 0, revision: 0, rev: 1, bytes: (root) => `<tbody><tr><td n>${root.getAttribute('data-id') || 'second'}</td></tr></tbody>` };
  state.spec = {
    selector: 'section[item] > table[grid]',
    serialize: (root) => { state.serialize++; return state.bytes(root); },
    revision: () => { state.revision++; return state.rev; },
  };
  return state;
}

beforeAll(async () => {
  window.clayEditMode = true;
  snapshot = await import('../../src/core/snapshot.js');
  regions = await import('../../src/lib/owned-regions.js');
  steps = await import('../../src/core/serialize-steps.js');
});

const register = ({ selector, ...spec }) => regions.own(selector, spec);
let release = null;
beforeEach(() => { document.body.innerHTML = SHEET; });
afterEach(() => { release?.dispose(); release = null; });

function everyOutput(api) {
  const save = api.captureForSaveAndComparison({ emitForSync: false });
  const both = api.captureForComparisonAndDirty();
  const clone = api.captureSnapshot({ flushUndo: false });
  return {
    forSave: save.forSave, forComparison: save.forComparison, forDirty: save.forDirty,
    comparison: api.captureForComparison(), dirty: api.captureForDirtyCheck(),
    bothComparison: both.forComparison, bothDirty: both.forDirty,
    sync: api.serializeForSync(clone), page: api.getPageContents(), recovery: api.captureRecoveryPage(),
    recoveryClone: api.serializeRecoveryClone(clone), captureForSave: api.captureForSave({ emitForSync: false }),
  };
}

test('a registered region is written by its owner in every byte output and never by outerHTML', () => {
  const own = owner();
  release = register(own.spec);
  const out = everyOutput(snapshot);
  for (const key of ['forSave', 'sync', 'page', 'recovery', 'recoveryClone', 'captureForSave']) {
    expect([key, out[key].includes('<table grid="" data-id="grid-1"><tbody><tr><td n>grid-1</td></tr></tbody></table>')]).toEqual([key, true]);
    expect([key, out[key].includes('<tbody><tr><td n>second</td></tr></tbody>')]).toEqual([key, true]);
    expect([key, out[key].includes('clay-owned')]).toEqual([key, false]);
    expect([key, out[key].includes('=A1*2')]).toEqual([key, false]);
  }
  for (const key of ['forComparison', 'forDirty', 'comparison', 'dirty', 'bothComparison', 'bothDirty']) {
    expect([key, out[key].includes('<table grid="" data-id="grid-1"><!--clay-owned-rev:1--></table>')]).toEqual([key, true]);
    expect([key, out[key].includes('grid-1</td>')]).toEqual([key, false]);
  }
  expect(out.forComparison).toBe(out.comparison);
  expect(out.forDirty).toBe(out.dirty);
});

test('a save capture calls serialize once per region and a comparison capture never calls it', () => {
  const own = owner();
  release = register(own.spec);
  own.serialize = own.revision = 0;
  snapshot.captureForSaveAndComparison({ emitForSync: false });
  expect([own.serialize, own.revision]).toEqual([2, 2]);
  own.serialize = own.revision = 0;
  snapshot.captureForComparison();
  snapshot.captureForDirtyCheck();
  snapshot.captureForComparisonAndDirty();
  expect([own.serialize, own.revision]).toEqual([0, 6]);
});

test('the bytes are pinned at capture time and travel with every copy of the clone', () => {
  const own = owner();
  release = register(own.spec);
  const clone = snapshot.captureSnapshot({ flushUndo: false });
  own.bytes = () => '<tbody><tr><td>later</td></tr></tbody>';
  own.rev = 2;
  const copy = clone.cloneNode(true);
  release.dispose();
  release = null;
  for (const html of [snapshot.serializeForSync(copy), snapshot.serializeRecoveryClone(copy), drain(steps.serializeForSyncSteps(snapshot.copyCaptureClone(clone)))]) {
    expect(html).toContain('<td n>grid-1</td>');
    expect(html).not.toContain('later');
    expect(html).not.toContain('clay-owned');
  }
});

test('the dirty and comparison strings move only when the revision moves', () => {
  const own = owner();
  release = register(own.spec);
  const first = snapshot.captureForComparisonAndDirty();
  document.querySelector('table[grid] td').textContent = 'raw write the owner did not make';
  expect(snapshot.captureForComparisonAndDirty()).toEqual(first);
  own.rev = 2;
  const second = snapshot.captureForComparisonAndDirty();
  expect(second.forDirty).not.toBe(first.forDirty);
  expect(second.forDirty).toContain('<!--clay-owned-rev:2-->');
});

test('an owner that throws is replaced by the generic path in the same capture', () => {
  const own = owner();
  const errors = [];
  const spy = jest.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });
  own.spec.serialize = (root) => { if (root.hasAttribute('data-id')) throw new Error('boom'); return '<tbody><tr><td>ok</td></tr></tbody>'; };
  release = register(own.spec);
  const first = snapshot.captureForSaveAndComparison({ emitForSync: false }).forSave;
  const second = snapshot.captureForSaveAndComparison({ emitForSync: false }).forSave;
  spy.mockRestore();
  expect(first).toContain('<td f="=A1*2" n="">2</td>');
  expect(first).toContain('<tbody><tr><td>ok</td></tr></tbody>');
  expect(first).not.toContain('clay-owned');
  expect(second).toBe(first);
  expect(errors.length).toBe(1);
});

test('an owner that throws an error with a code refuses the capture', () => {
  const own = owner();
  own.spec.serialize = () => { const error = new Error('edits are still pending'); error.code = 'sheet-pending'; throw error; };
  release = register(own.spec);
  expect(() => snapshot.captureForSaveAndComparison({ emitForSync: false })).toThrow('edits are still pending');
  expect(() => snapshot.captureForDirtyCheck()).not.toThrow();
});

test('a revision that throws never reads as saved and is reported once', () => {
  const own = owner();
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  own.spec.revision = () => { throw new Error('no revision'); };
  release = register(own.spec);
  const first = snapshot.captureForDirtyCheck();
  const second = snapshot.captureForDirtyCheck();
  const save = snapshot.captureForSaveAndComparison({ emitForSync: false });
  const reports = spy.mock.calls.length;
  spy.mockRestore();
  expect(reports).toBe(1);
  expect(second).not.toBe(first);
  expect(save.forDirty).not.toBe(second);
  expect(save.forComparison).not.toBe(snapshot.captureForComparison());
  expect(save.forSave).toContain('<td n>grid-1</td>');
  expect(save.forSave).not.toContain('clay-owned');
});

test('a root with freeze on it or above it is not owned', () => {
  const own = owner();
  release = register(own.spec);
  document.querySelector('[data-id="tab-1"]').setAttribute('clay', 'freeze');
  document.querySelector('[data-id="tab-2"] table').setAttribute('freeze', '');
  own.serialize = own.revision = 0;
  const clone = snapshot.captureSnapshot({ flushUndo: false });
  expect([own.serialize, own.revision]).toEqual([0, 0]);
  expect(clone.querySelectorAll('td').length).toBe(3);
  expect(snapshot.serializeForSync(clone)).toContain('<td f="=A1*2" n="">2</td>');
  document.querySelector('[data-id="tab-1"]').removeAttribute('clay');
  expect(snapshot.captureSnapshot({ flushUndo: false }).querySelectorAll('td').length).toBe(1);
  expect(own.serialize).toBe(1);
});

test('a region inside a stripped area leaves with it in every domain', () => {
  const own = owner();
  release = register(own.spec);
  document.querySelector('[data-id="tab-1"]').setAttribute('no-save', '');
  document.querySelector('[data-id="tab-2"]').setAttribute('clay', 'no-watch');
  const out = snapshot.captureForSaveAndComparison({ emitForSync: false });
  expect(out.forSave).not.toContain('grid-1');
  expect(out.forSave).toContain('<td n>second</td>');
  expect(out.forComparison).not.toContain('clay-owned');
  expect(snapshot.captureForDirtyCheck()).not.toContain('clay-owned');
});

test('a save renderer sees the marked text and its output is resolved after it returns', () => {
  const own = owner();
  release = register(own.spec);
  const seen = [];
  const restore = snapshot.setSaveRenderer((clone, today) => { seen.push(today); return today.replace('<h1', '<h1 data-rendered'); });
  let out;
  try { out = snapshot.captureForSaveAndComparison({ emitForSync: false }).forSave; } finally { if (typeof restore === 'function') restore(); else snapshot.setSaveRenderer(null); }
  expect(seen.length).toBe(1);
  expect(seen[0]).toContain('<!--clay-owned:');
  expect(out).toContain('<h1 data-rendered');
  expect(out).toContain('<td n>grid-1</td>');
  expect(out).not.toContain('clay-owned');
});

test('the sliced save job returns the same three strings as the one task capture', async () => {
  const own = owner();
  release = register(own.spec);
  const { beginSaveCapture } = await import('../../src/core/save-job.js');
  const job = beginSaveCapture({ emitForSync: false });
  const sliced = drain(job.steps());
  const whole = snapshot.captureForSaveAndComparison({ emitForSync: false });
  expect(sliced.forSave).toBe(whole.forSave);
  expect(sliced.forComparison).toBe(whole.forComparison);
  expect(sliced.forDirty).toBe(whole.forDirty);
  expect(sliced.forSave).toContain('<td n>grid-1</td>');
});

test('each capture asks the owner for the view it writes: the file view for a save and a page read, the shown view for sync, the kept view for a recovery copy', () => {
  const own = owner();
  own.spec.serialize = (root, context) => `<tbody><tr><td>${context?.purpose}</td></tr></tbody>`;
  release = register(own.spec);
  expect(snapshot.captureForSaveAndComparison({ emitForSync: false }).forSave).toContain('<td>save</td>');
  expect(snapshot.getPageContents()).toContain('<td>save</td>');
  expect(snapshot.captureBodyForSync()).toContain('<td>sync</td>');
  expect(snapshot.serializeForSync(snapshot.captureSnapshot({ flushUndo: false, purpose: 'sync' }))).toContain('<td>sync</td>');
  expect(snapshot.captureRecoveryPage()).toContain('<td>recovery</td>');
  expect(snapshot.captureRecoveryPage()).not.toContain('<td>save</td>');
});

test('the local capture for a merge asks the owner for the shown view, so an owner that refuses a save while edits are pending still merges', () => {
  const own = owner();
  const asked = [];
  own.spec.serialize = (root, context) => { asked.push(context?.purpose); return '<tbody></tbody>'; };
  release = register(own.spec);
  snapshot.captureForMerge();
  expect([...new Set(asked)]).toEqual(['sync']);
});

import { beforeEach, afterEach, expect, jest, test } from "@jest/globals";
import { IDBKeyRange } from "fake-indexeddb";
import { createStore } from "../../src/plugins/visitor-drafts/store.js";
import { openSession } from "../../src/plugins/visitor-drafts/session.js";
import { openDrafts } from "../../src/plugins/visitor-drafts/idb.js";
import { recoveryKey } from "../../src/plugins/visitor-drafts/commit.js";
import { createRecovery } from "../../src/plugins/visitor-drafts/recovery.js";
import { getPageContents, onSnapshot } from "../../src/core/snapshot.js";
import { beginSaveCapture } from "../../src/core/save-job.js";
import { runSliced } from "../../src/lib/slice.js";
import { startDirtyGate, gateCaptureToken, gateTokenNow, gateUnchangedSince, gateRevision, gateMarkDirty } from "../../src/lib/dirty-gate.js";
import { draftGate } from "../../src/core/draft-mode.js";
import enablePersist from "../../src/core/persist.js";
import { RULES, SERVED, world, openTab, stored } from "./helpers/visitor-drafts-session.js";

const out = (line) => process.stdout.write(`PROBE ${line}\n`);
const STAMP = "this.querySelector('time').textContent = String(Date.now())";
const STAMP_TITLE = "this.textContent = 'save stamp ' + (++window.__stamps)";
const HANDLER = "[onbeforesave], [onbeforesnapshot]";
enablePersist();
const copy = (id, data) => ({ v: 1, id, savedAt: "2026-11-11T12:00:00.000Z", data });
const ids = (count) => Array.from({ length: count }, (_, i) => "r" + i);

// A snapshot hook that changes the stamp on a page whose handler attribute has been taken
// away, so a capture still differs while the gate records nothing.
let snapshotStamp = false;
let snapshotStamps = 0;
onSnapshot((clone) => {
  if (!snapshotStamp) return;
  const time = clone.querySelector("time") || clone.querySelector("#stamp");
  if (time) time.textContent = String(++snapshotStamps);
});

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.clay = { getHTML: getPageContents }; startDirtyGate(); });
afterEach(() => {
  jest.restoreAllMocks();
  delete window.clay;
  delete window.__stamps;
  delete window.__stamp;
  snapshotStamp = false;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

async function keep(w, copies) {
  const db = await openDrafts({ factory: w.factory, keyRange: IDBKeyRange });
  await db.change(w.key, (raw) => {
    const meta = JSON.parse(raw.meta);
    meta.recovery = copies.map(([mark]) => mark);
    return { puts: [[w.key + ":meta", JSON.stringify(meta)], ...copies.map(([mark, value]) => [recoveryKey(w.key, mark), JSON.stringify(value)])], deletes: [], result: null };
  });
  db.close();
}

async function open({ rules, body, gate, slotLimit, w = world({ rules }) }) {
  document.documentElement.setAttribute("visitor-drafts", w.slot);
  document.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${rules}</script>`;
  if (body) document.body.innerHTML = body;
  let clock = w.clock;
  jest.spyOn(Date, "now").mockImplementation(() => ++clock);
  const store = createStore({ doc: document, storage: localStorage, path: w.path, now: () => new Date(w.clock), ...(gate !== undefined && { gate }), ...(slotLimit && { slotLimit }) });
  store.restore();
  const tab = { w, store, reloads: 0 };
  tab.session = await openSession({ store, storage: localStorage, doc: document, now: () => w.clock, reload: () => tab.reloads++ });
  await tab.session.first;
  tab.durable = async () => JSON.stringify([...(await stored(w)).all]) + JSON.stringify(Object.entries(localStorage));
  // Every copy the database keeps for this draft, by mark, exact and unclassified.
  tab.marks = async () => {
    await openTab(w, { rules });
    const prefix = w.key + ":recovery:";
    return [...(await stored(w)).all.keys()].filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
  };
  tab.originals = async (original) => new Set((await tab.marks()).filter((mark) => original.includes(mark)));
  tab.startOverElsewhere = async () => { localStorage.setItem(w.key + ":reset", "2~another-tab"); await tab.session.sync(); };
  tab.notice = () => sessionStorage.getItem(w.key + ":recovery-notice");
  return tab;
}

const PLAIN = { rules: '{"note":"#note","stamp":"#stamp"}', body: '<p id="note" contenteditable="true">served text</p><p id="stamp" onbeforesave="this.textContent = String(Date.now())">0</p>' };
const RICH = { rules: '{"note":"#note@innerHTML"}', body: `<section id="note" onbeforesave="${STAMP}"><p contenteditable="true">served text</p><time>0</time></section>` };
const MOVED = {
  rules: RULES,
  body: `<h1 id="title" onbeforesave="${STAMP_TITLE}">${SERVED.title}</h1><input id="note" persist value="${SERVED.note}"><ul id="rows"><li item cms-template data-id=""><span class="n"></span></li>${SERVED.rows.map((r) => `<li item data-id="${r.id}"><span class="n">${r.name}</span></li>`).join("")}</ul>`,
};

test("the gate seam is live and the stamp handler makes every capture differ", () => {
  document.body.innerHTML = RICH.body;
  expect(draftGate()).not.toBeNull();
  jest.spyOn(Date, "now").mockImplementation((() => { let n = 0; return () => ++n; })());
  expect(getPageContents()).not.toBe(getPageContents());
});

for (const gate of ["real", "none"]) {
  test(`stamp page, saved, no edit, eight kept copies, another tab starts over, gate ${gate}`, async () => {
    const t = await open({ ...RICH, ...(gate === "none" && { gate: () => null }) });
    const kept = ids(8);
    await keep(t.w, kept.map((id) => [id, copy(id, { note: "kept " + id.slice(1) })]));
    document.querySelector("#note p").textContent = "saved text";
    t.store.captureNow();
    await t.session.sync();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.startOverElsewhere();
    expect(t.reloads).toBe(1);
    const pending = t.store.chain().ops.length;
    const originals = await t.originals(kept);
    const marks = await t.marks();
    out(`no edit, gate ${gate}: operations left ${pending}, originals kept ${originals.size} of 8, other copies ${marks.length - originals.size}, notice ${t.notice()}`);
    if (gate === "real") {
      expect(pending).toBe(0);
      expect(originals).toEqual(new Set(kept));
      expect(t.notice()).toBeNull();
    } else {
      expect(pending).toBe(1);
      expect(originals.size).toBe(7);
    }
  });
}

for (const how of ["mutation only", "input event"]) {
  test(`stamp page, a sentence typed after the last save survives another tab's Start over, ${how}`, async () => {
    const t = await open(RICH);
    document.querySelector("#note p").textContent = "saved text";
    t.store.captureNow();
    await t.session.sync();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const p = document.querySelector("#note p");
    p.textContent = "the visitor's new unsaved sentence";
    if (how === "input event") p.dispatchEvent(new Event("input", { bubbles: true }));
    await t.startOverElsewhere();
    expect(t.reloads).toBe(1);
    expect(await t.durable()).toContain("the visitor's new unsaved sentence");
    expect(t.store.chain().ops.length).toBe(1);
  });
}

for (const gate of ["real", "none"]) {
  test(`stamp page, Restore with seven kept copies, gate ${gate}`, async () => {
    const t = await open({ ...PLAIN, ...(gate === "none" && { gate: () => null }) });
    const kept = ids(7);
    await keep(t.w, kept.map((id) => [id, copy(id, { note: "kept " + id.slice(1), stamp: "0" })]));
    document.querySelector("#note").textContent = "current visitor typing";
    t.store.captureNow();
    await t.session.sync();
    const recovery = createRecovery({ store: t.store, session: t.session, getHTML: getPageContents });
    await recovery.restore("r2");
    expect(t.reloads).toBe(1);
    const pending = t.store.chain().ops.length;
    const originals = await t.originals(kept);
    const durable = await t.durable();
    out(`restore, gate ${gate}: operations left ${pending}, originals kept ${originals.size} of 7, current typing kept ${durable.includes("current visitor typing")}`);
    expect(durable).toContain("current visitor typing");
    if (gate === "real") {
      expect(pending).toBe(0);
      expect(originals).toEqual(new Set(kept));
    } else {
      expect(originals.size).toBeLessThan(kept.length);
    }
  });
}

test.each([false, true])("restore ends when a save handler changes a tracked field on every capture, r-prefixed ids %s", async (prefixIds) => {
  if (prefixIds) {
    let sequence = 0;
    jest.spyOn(Math, "random").mockImplementation(() => (27 + ++sequence / 10000) / 36);
  }
  const t = await open(MOVED);
  const kept = ids(7);
  await keep(t.w, kept.map((id) => [id, copy(id, { ...SERVED, note: "kept " + id.slice(1) })]));
  document.getElementById("note").value = "current visitor typing";
  window.__stamps = 0;
  const recovery = createRecovery({ store: t.store, session: t.session, getHTML: getPageContents });
  await expect(recovery.restore("r2")).resolves.toMatchObject({ restoredCopy: true });
  expect(window.__stamps).toBeGreaterThan(1);
  expect(window.__stamps).toBeLessThanOrEqual(5);
  expect(t.reloads).toBe(1);
  const after = await stored(t.w);
  const copies = [...after.all].filter(([name]) => name.startsWith(t.w.key + ":recovery:")).map(([, raw]) => JSON.parse(raw));
  expect(after.record.data.note).toBe("kept 2");
  expect(copies).toHaveLength(8);
  expect(copies.some((record) => record.data?.note === "current visitor typing")).toBe(true);
  expect(new Set(copies.map((record) => record.id).filter((id) => kept.includes(id)))).toEqual(new Set(kept));
  expect(copies.some((record) => record.id === "r2")).toBe(true);
  expect([...after.all.keys()].filter((name) => name.includes(":conflict"))).toHaveLength(0);
});

for (const stamped of [false, true]) for (const slotLimit of [50000, 1]) {
  test(`typing while a sliced save prepares survives Start over, stamp handler ${stamped}, slot ${slotLimit}`, async () => {
    const t = await open({
      rules: '{"note":"#note@innerHTML"}',
      body: `<section id="note"${stamped ? ` onbeforesave="${STAMP}"` : ""}><p contenteditable="true">served text</p><time>0</time></section>`,
      slotLimit,
    });
    const p = document.querySelector("#note p");
    p.textContent = "checkpoint before typing";
    await Promise.resolve();
    const at = gateCaptureToken();
    const job = beginSaveCapture({ emitForSync: false });
    let yields = 0;
    const capture = await runSliced(job.steps(), { budgetMs: 0, yieldTask: async () => { yields++; p.textContent = "visitor typed during preparation"; } });
    expect(yields).toBeGreaterThan(0);
    expect(capture.forSave).toContain("checkpoint before typing");
    expect(capture.forSave).not.toContain("visitor typed during preparation");
    t.store.capture(capture.forSave, { at });
    await t.session.sync();
    await t.startOverElsewhere();
    job.drop();
    expect(t.reloads).toBe(1);
    expect(await t.durable()).toContain("visitor typed during preparation");
  });
}

test("a value written to a persist control with no event after the last save is kept on a handler page", async () => {
  const t = await open({ rules: '{"f":"#f@value","note":"#note@innerHTML"}', body: `<input id="f" persist value="a">${RICH.body}` });
  t.store.captureNow();
  await t.session.sync();
  document.getElementById("f").value = "typed with no event";
  await t.startOverElsewhere();
  expect(await t.durable()).toContain("typed with no event");
});

test("residual: a stamp page that has not saved since it loaded leaves a stamp-only operation", async () => {
  const first = await open(RICH);
  document.querySelector("#note p").textContent = "saved text";
  first.store.captureNow();
  await first.session.sync();
  Date.now.mockRestore();
  const t = await open({ rules: RICH.rules, w: first.w });
  await t.startOverElsewhere();
  expect(t.reloads).toBe(1);
  const ops = t.store.chain().ops;
  out(`idle since load: operations left ${ops.length}, keys ${JSON.stringify(ops.map((op) => Object.keys(op.keys)))}`);
  expect(ops.length).toBe(1);
});

test("residual: an edit the gate is told to ignore is dropped on a handler page with no other edit", async () => {
  const t = await open({ rules: '{"q":"#q","note":"#note@innerHTML"}', body: `<div clay="no-dirty"><p id="q">served q</p></div>${RICH.body}` });
  t.store.captureNow();
  await t.session.sync();
  document.getElementById("q").textContent = "changed inside no-dirty";
  await t.startOverElsewhere();
  const kept = (await t.durable()).includes("changed inside no-dirty");
  out(`no-dirty region edit kept: ${kept}`);
  expect(kept).toBe(false);
});

test("all three conditions hold: a quiet stamp page leaves no operation when its generation ends", async () => {
  const t = await open(PLAIN);
  t.store.captureNow();
  await t.session.sync();
  const at = gateCaptureToken();
  expect(document.querySelector(HANDLER)).not.toBeNull();
  expect(gateRevision()).toBe(at.gen);
  expect(gateUnchangedSince(at)).toBe(true);
  await t.startOverElsewhere();
  expect(t.reloads).toBe(1);
  expect(gateUnchangedSince(at)).toBe(true);
  expect(t.store.chain().ops).toHaveLength(0);
});

test("only the token is missing: a capture with no at leaves a stamp operation", async () => {
  const t = await open(PLAIN);
  t.store.captureNow();
  await t.session.sync();
  const at = gateCaptureToken();
  expect(document.querySelector(HANDLER)).not.toBeNull();
  t.store.capture(getPageContents());
  await t.session.sync();
  expect(gateRevision()).toBe(at.gen);
  await t.startOverElsewhere();
  expect(gateUnchangedSince(at)).toBe(true);
  const left = t.store.chain().ops;
  expect(left).toHaveLength(1);
  expect(Object.keys(left[0].keys)).toEqual(["stamp"]);
});

test("only the handler attribute is missing: a snapshot callback that changes the stamp leaves a stamp operation", async () => {
  const t = await open(PLAIN);
  t.store.captureNow();
  await t.session.sync();
  document.getElementById("stamp").removeAttribute("onbeforesave");
  snapshotStamp = true;
  const at = gateTokenNow();
  expect(document.querySelector(HANDLER)).toBeNull();
  t.store.captureNow();
  await t.session.sync();
  expect(gateRevision()).toBe(at.gen);
  await t.startOverElsewhere();
  expect(gateUnchangedSince(at)).toBe(true);
  const left = t.store.chain().ops;
  expect(left).toHaveLength(1);
  expect(Object.keys(left[0].keys)).toEqual(["stamp"]);
});

test("only the gate has moved: a stamp operation is left", async () => {
  const t = await open(PLAIN);
  t.store.captureNow();
  await t.session.sync();
  const at = gateCaptureToken();
  expect(document.querySelector(HANDLER)).not.toBeNull();
  gateMarkDirty();
  expect(gateUnchangedSince(at)).toBe(false);
  await t.startOverElsewhere();
  expect(t.reloads).toBe(1);
  const left = t.store.chain().ops;
  expect(left).toHaveLength(1);
  expect(Object.keys(left[0].keys)).toEqual(["stamp"]);
});

test("a capture with no at clears a formerly known token even when it records nothing", async () => {
  const t = await open({ rules: '{"note":"#note","stamp":"#stamp"}', body: '<p id="note" contenteditable="true">served text</p><p id="stamp" onbeforesave="if (window.__stamp) this.textContent = String(Date.now())">0</p>' });
  document.getElementById("note").textContent = "saved text";
  t.store.captureNow();
  await t.session.sync();
  const at = gateCaptureToken();
  expect(document.querySelector(HANDLER)).not.toBeNull();
  expect(t.store.capture(getPageContents())).toBeNull();
  await t.session.sync();
  window.__stamp = true;
  await t.startOverElsewhere();
  expect(gateUnchangedSince(at)).toBe(true);
  const left = t.store.chain().ops;
  expect(left).toHaveLength(1);
  expect(Object.keys(left[0].keys)).toEqual(["stamp"]);
});

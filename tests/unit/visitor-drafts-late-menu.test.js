import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { IDBKeyRange } from "fake-indexeddb";
import { createStore } from "../../src/plugins/visitor-drafts/store.js";
import { openSession } from "../../src/plugins/visitor-drafts/session.js";
import { openDrafts } from "../../src/plugins/visitor-drafts/idb.js";
import { recoveryKey } from "../../src/plugins/visitor-drafts/commit.js";
import { createRecovery } from "../../src/plugins/visitor-drafts/recovery.js";
import { openRecovery } from "../../src/plugins/visitor-drafts/recovery-menu.js";
import { getPageContents } from "../../src/core/snapshot.js";
import { startDirtyGate, gateTokenNow, gateUnchangedSince } from "../../src/lib/dirty-gate.js";
import enablePersist from "../../src/core/persist.js";
import modal from "../../src/ui/modal.js";
import { RULES, SERVED, world, openTab, stored } from "./helpers/visitor-drafts-session.js";

const out = (line) => process.stdout.write(`PROBE ${line}\n`);
const STAMP_TITLE = "this.textContent = 'save stamp ' + (++window.__stamps)";
enablePersist();
const copy = (id, data) => ({ v: 1, id, savedAt: "2026-11-11T12:00:00.000Z", data });
const ids = (count) => Array.from({ length: count }, (_, i) => "r" + i);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.scrollTo = () => {};
  window.clay = { getHTML: getPageContents };
  startDirtyGate();
});
afterEach(() => {
  modal.close();
  jest.restoreAllMocks();
  delete window.clay;
  delete window.__stamps;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
});

async function waitFor(predicate, steps = 400) {
  for (let step = 0; step < steps; step++) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

const button = (root, label) => [...root.querySelectorAll("button")].find((el) => el.textContent === label);
const restoreButton = (root, mark) => button([...root.querySelectorAll("li")].find((li) => li.dataset.draftMark === mark), "Restore");
const pressEscape = () => {
  const event = new KeyboardEvent("keydown", { key: "Escape" });
  Object.defineProperty(event, "keyCode", { value: 27 });
  document.dispatchEvent(event);
};

async function keep(w, copies) {
  const db = await openDrafts({ factory: w.factory, keyRange: IDBKeyRange });
  await db.change(w.key, (raw) => {
    const meta = JSON.parse(raw.meta);
    meta.recovery = copies.map(([mark]) => mark);
    return { puts: [[w.key + ":meta", JSON.stringify(meta)], ...copies.map(([mark, value]) => [recoveryKey(w.key, mark), JSON.stringify(value)])], deletes: [], result: null };
  });
  db.close();
}

async function open({ rules, body, gate, w = world({ rules }) }) {
  document.documentElement.setAttribute("visitor-drafts", w.slot);
  document.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${rules}</script>`;
  if (body) document.body.innerHTML = body;
  let clock = w.clock;
  jest.spyOn(Date, "now").mockImplementation(() => ++clock);
  const store = createStore({ doc: document, storage: localStorage, path: w.path, now: () => new Date(w.clock), ...(gate !== undefined && { gate }) });
  store.restore();
  const tab = { w, store, reloads: 0 };
  tab.session = await openSession({ store, storage: localStorage, doc: document, now: () => w.clock, reload: () => tab.reloads++ });
  await tab.session.first;
  tab.durable = async () => JSON.stringify([...(await stored(w)).all]) + JSON.stringify(Object.entries(localStorage));
  tab.marks = async () => {
    await openTab(w, { rules });
    const prefix = w.key + ":recovery:";
    return [...(await stored(w)).all.keys()].filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
  };
  tab.originals = async (original) => new Set((await tab.marks()).filter((mark) => original.includes(mark)));
  tab.recovery = () => createRecovery({ store, session: tab.session, getHTML: getPageContents });
  return tab;
}

const MOVED = {
  rules: RULES,
  body: `<h1 id="title" onbeforesave="${STAMP_TITLE}">${SERVED.title}</h1><input id="note" persist value="${SERVED.note}"><ul id="rows"><li item cms-template data-id=""><span class="n"></span></li>${SERVED.rows.map((r) => `<li item data-id="${r.id}"><span class="n">${r.name}</span></li>`).join("")}</ul>`,
};

// The dialog's scroll lock is an ordinary body style write, so opening and closing the dialog
// count as changes: the next autosave then clears a lock that a save taken while the dialog was
// open wrote into the file (Opus, drafts r6 review). The menu's Restore still keeps every
// original copy (the test below); only Escape during the restore transaction can add one.
test("the recovery dialog's scroll lock is a counted change, and closing it clears the lock", async () => {
  const t = await open(MOVED);
  await keep(t.w, ids(2).map((id) => [id, copy(id, { ...SERVED, note: "kept " + id.slice(1) })]));
  const token = gateTokenNow();
  const root = await openRecovery(t.recovery());
  expect(document.body.style.overflow).toBe("hidden");
  expect(root.closest("[data-clay-modal]").getAttribute("clay")).toBe("no-save no-watch no-snapshot");
  expect(gateUnchangedSince(token)).toBe(false);
  const closing = gateTokenNow();
  modal.close();
  expect(document.body.style.overflow).toBe("");
  expect(gateUnchangedSince(closing)).toBe(false);
});

test("a watched edit made in the same task as the dialog's scroll write is still counted", async () => {
  const t = await open(MOVED);
  const token = gateTokenNow();
  document.getElementById("title").textContent = "edited in the same task as the open";
  modal.html = "Closing soon";
  modal.no = "Close";
  modal.open();
  out(`text then open: gate unchanged ${gateUnchangedSince(token)}, overflow ${JSON.stringify(document.body.style.overflow)}`);
  expect(gateUnchangedSince(token)).toBe(false);
  modal.close();
});

test("an input value write with its event in the same task as the dialog's scroll write stays counted", async () => {
  const t = await open(MOVED);
  const token = gateTokenNow();
  const note = document.getElementById("note");
  note.value = "typed with the dialog";
  note.dispatchEvent(new Event("input", { bubbles: true }));
  modal.html = "Closing soon";
  modal.no = "Close";
  modal.open();
  modal.close();
  out(`input then open and close: gate unchanged ${gateUnchangedSince(token)}, value ${JSON.stringify(note.value)}`);
  expect(gateUnchangedSince(token)).toBe(false);
  expect(note.value).toBe("typed with the dialog");
});

test("the menu's Restore keeps every original copy and the visitor's typing", async () => {
  const t = await open(MOVED);
  const kept = ids(7);
  await keep(t.w, kept.map((id) => [id, copy(id, { ...SERVED, note: "kept " + id.slice(1) })]));
  document.getElementById("note").value = "current visitor typing";
  window.__stamps = 0;
  const root = await openRecovery(t.recovery());
  restoreButton(root, "r2").click();
  expect(await waitFor(() => t.reloads === 1)).toBe(true);
  const marks = await t.marks();
  const originals = await t.originals(kept);
  const durable = await t.durable();
  out(`menu restore: reloads ${t.reloads}, operations left ${t.store.chain().ops.length}, originals kept ${originals.size} of 7, other copies ${marks.filter((mark) => !kept.includes(mark)).length}, typing kept ${durable.includes("current visitor typing")}`);
  expect(originals).toEqual(new Set(kept));
  expect(marks.filter((mark) => !kept.includes(mark))).toHaveLength(1);
  expect(t.store.chain().ops).toHaveLength(0);
  expect(durable).toContain("current visitor typing");
});

// Design limit (drafts-late-design section 7): Escape during the restore transaction clears the
// dialog's scroll lock, a counted change, so on a page with a save stamp the late capture falls back
// to v3 and keeps at most one stamp-only copy. No visitor typing is lost.
test("dismissing the dialog while the restore transaction finishes keeps the visitor's typing and evicts at most one original", async () => {
  const t = await open(MOVED);
  const kept = ids(7);
  await keep(t.w, kept.map((id) => [id, copy(id, { ...SERVED, note: "kept " + id.slice(1) })]));
  document.getElementById("note").value = "current visitor typing";
  window.__stamps = 0;
  const root = await openRecovery(t.recovery());
  let escaped = false;
  const acknowledge = t.store.acknowledge;
  t.store.acknowledge = (seq) => {
    const acknowledged = acknowledge(seq);
    if (!escaped) {
      escaped = true;
      pressEscape();
    }
    return acknowledged;
  };
  restoreButton(root, "r2").click();
  expect(await waitFor(() => t.reloads === 1)).toBe(true);
  const originals = await t.originals(kept);
  out(`menu restore with Escape: escaped ${escaped}, dialogs left ${document.querySelectorAll("[data-clay-modal]").length}, operations left ${t.store.chain().ops.length}, originals kept ${originals.size} of 7, overflow ${JSON.stringify(document.body.style.overflow)}`);
  expect(escaped).toBe(true);
  expect(document.querySelectorAll("[data-clay-modal]")).toHaveLength(0);
  expect(kept.length - originals.size).toBeLessThanOrEqual(1);
  expect(t.store.chain().ops.length).toBeLessThanOrEqual(1);
  expect(await t.durable()).toContain("current visitor typing");
});

test("control: without a gate the same menu Restore still loses an original copy", async () => {
  const t = await open({ ...MOVED, gate: () => null });
  const kept = ids(7);
  await keep(t.w, kept.map((id) => [id, copy(id, { ...SERVED, note: "kept " + id.slice(1) })]));
  document.getElementById("note").value = "current visitor typing";
  window.__stamps = 0;
  const root = await openRecovery(t.recovery());
  restoreButton(root, "r2").click();
  expect(await waitFor(() => t.reloads === 1)).toBe(true);
  const originals = await t.originals(kept);
  out(`no gate: reloads ${t.reloads}, originals kept ${originals.size} of 7`);
  expect(originals.size).toBeLessThan(kept.length);
});

test("typing into the page while the restore transaction finishes is kept through the next load", async () => {
  const t = await open(MOVED);
  const kept = ids(7);
  await keep(t.w, kept.map((id) => [id, copy(id, { ...SERVED, note: "kept " + id.slice(1) })]));
  const note = document.getElementById("note");
  note.value = "current visitor typing";
  window.__stamps = 0;
  const root = await openRecovery(t.recovery());
  let typed = false;
  const acknowledge = t.store.acknowledge;
  t.store.acknowledge = (seq) => {
    const acknowledged = acknowledge(seq);
    if (!typed) {
      typed = true;
      note.value = "typed while the draft was being restored";
      note.dispatchEvent(new Event("input", { bubbles: true }));
      pressEscape();
    }
    return acknowledged;
  };
  restoreButton(root, "r2").click();
  expect(await waitFor(() => t.reloads === 1)).toBe(true);
  const marks = await t.marks();
  const durable = await t.durable();
  out(`typing during the transaction: typed ${typed}, copies ${marks.length}, kept ${durable.includes("typed while the draft was being restored")}`);
  expect(typed).toBe(true);
  expect(durable).toContain("typed while the draft was being restored");
});

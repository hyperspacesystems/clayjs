import { beforeEach, expect, test } from "@jest/globals";
import { commit, recoveryMark, settled } from "../../src/plugins/visitor-drafts/commit.js";
import { openDrafts } from "../../src/plugins/visitor-drafts/idb.js";
import { merge3, unitMark } from "../../src/plugins/visitor-drafts/store.js";
import { SERVED, openTab, stored, transactOnce, world } from "./helpers/visitor-drafts-session.js";

const KEPT_ASIDE = "A tab that was open before an update saved another copy of this draft. That copy was kept aside, and this draft was not changed. Reload that tab to go on from this draft.";
const notices = () => [...(document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot?.querySelectorAll("[data-clay-toast]") ?? [])].map((el) => el.textContent);
const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
const recovery = (w, state) => [...state.all].filter(([name]) => name.startsWith(w.key + ":recovery:")).map(([, value]) => JSON.parse(value));

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); delete window.clay; document.querySelectorAll("clay-editor-ui").forEach((el) => el.remove()); });

test.each(["applied", "unapplied"])("a no-database tab cannot undo Start over (%s marker)", async (mode) => {
  const w = world();
  const issuer = await openTab(w);
  issuer.title("DISCARDED title");
  await issuer.save();
  const offline = await openTab(w, { database: false });
  expect(offline.shows().title).toBe("DISCARDED title");
  const oldReset = offline.store.generation();
  offline.note("typed in the no-database tab");
  if (mode === "applied") await issuer.session.startOver();
  else {
    localStorage.removeItem(w.key);
    localStorage.setItem(w.key + ":reset", "2~unapplied");
  }
  const marker = w.local(":reset");
  await pause();
  expect(notices()).toEqual([]);
  offline.store.write(offline.html());
  const local = w.parsed();
  expect(local.reset).toBe(oldReset);
  expect(local.data.note).toBe("typed in the no-database tab");
  const fresh = await openTab(w);
  await pause();
  const after = await stored(w);
  expect(after.record).toBe(null);
  expect(after.v1base).toBe(null);
  expect(after.meta.reset).toBe(marker);
  expect(after.meta.foreign).toBe(local.id);
  expect(recovery(w, after)).toEqual([local]);
  if (mode === "applied") expect(notices()).toEqual([KEPT_ASIDE]);
  const again = await fresh.sync();
  expect(again.recovered).toEqual([]);
  expect(again.released).toEqual([]);
  expect(recovery(w, await stored(w))).toEqual([local]);
});

test("the tab that pressed Start over stays silent when it takes in the late fallback copy", async () => {
  const w = world();
  const issuer = await openTab(w);
  issuer.title("discarded draft");
  await issuer.save();
  const offline = await openTab(w, { database: false });
  offline.note("late fallback typing");
  await issuer.session.startOver();
  offline.store.write(offline.html());
  const local = w.parsed();
  const result = await issuer.sync();
  expect(result.released).toEqual([local]);
  expect(result.record).toBe(null);
  expect(recovery(w, await stored(w))).toEqual([local]);
  expect(issuer.store.stopped()).toBe(true);
  await pause();
  expect(notices()).toEqual([]);
  expect(sessionStorage.getItem(w.key + ":recovery-notice")).toBe(null);
});

test.each([null, { v: 1, id: "current", data: { ...SERVED, title: "current draft" } }])("an ended token takes precedence over an empty draft or a held merge base (%j)", (record) => {
  const meta = { gen: 2, rev: 3, reset: "2~current", ended: [""], tabs: {}, foreign: null, unit: null };
  const local = { v: 1, id: "late", reset: "", ancestry: ["current"], data: { ...SERVED, note: "late typing" } };
  const result = commit({ meta, record }, { seed: SERVED, newId: () => "new", now: 1, merge3, unitMark, local });
  expect(result.record).toEqual(record);
  expect(result.meta.foreign).toBe(local.id);
  expect(result.meta.rev).toBe(meta.rev);
  expect(result.recovered).toEqual([local]);
  expect(result.released).toEqual([local]);
});

test.each([undefined, "2~current", "unknown", 0])("intake keeps existing rules for tokens not known to have ended (%s)", (reset) => {
  const meta = { gen: 2, rev: 3, reset: "2~current", ended: [""], tabs: {}, foreign: null, unit: null };
  const local = { v: 1, id: "foreign", reset, data: SERVED };
  const result = commit({ meta, record: null }, { seed: SERVED, newId: () => "new", now: 1, merge3, unitMark, local });
  expect(result.record).toEqual(JSON.parse(JSON.stringify(local)));
  expect(result.recovered).toEqual([]);
  expect(result.released).toEqual([]);
});

test("an entry that is not a chain is cleaned only after its exact recovery copy is committed", async () => {
  const w = world();
  const tab = await openTab(w);
  tab.title("current draft");
  await tab.save();
  const before = await stored(w);
  const copy = { v: 1, id: "unreadable-chain", data: { ...SERVED, note: "preserve this copy" } };
  const slot = w.key + ":op:unreadable";
  const malformed = w.key + ":op:malformed";
  const drafts = await openDrafts();
  await drafts.putRow(slot, JSON.stringify(copy));
  await drafts.putRow(malformed, "{not json");
  drafts.close();
  expect(settled(copy, before.meta)).toBe(false);
  expect(settled(null, { ...before.meta, recovery: ["at:undefined"] })).toBe(false);
  await transactOnce(w, {});
  expect((await stored(w)).all.get(slot)).toBe(JSON.stringify(copy));
  const result = await transactOnce(w, { local: copy });
  expect(result.recovered).toEqual([copy]);
  expect(settled(copy, result.meta)).toBe(true);
  expect(settled({ ...copy, id: "another-copy" }, result.meta)).toBe(false);
  const after = await stored(w);
  expect(after.record).toEqual(before.record);
  expect(after.all.has(slot)).toBe(false);
  expect(after.all.get(malformed)).toBe("{not json");
  expect(JSON.parse(after.all.get(w.key + ":recovery:" + recoveryMark(copy)))).toEqual(copy);
});

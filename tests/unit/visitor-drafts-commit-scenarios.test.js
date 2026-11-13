import { expect, test } from "@jest/globals";
import { KEY, openTab, stored, world } from "./helpers/visitor-drafts-tabs.js";

// The design pass scenarios (big/20261112-drafts-design/fable-scratch/scenarios.test.mjs, the
// ten that need no 1.23.0 tab; those come with step 4), run on the real transaction. Each
// names the Gate C finding it re-expresses where it has one.
const expectEqual = (got, want, label) => {
  if (label === undefined) return expect(got).toEqual(want);
  expect({ [label]: got }).toEqual({ [label]: want });
};

const SERVED = { title: "owner title", note: "owner note", cards: [{ id: 1, text: "one" }] };
const big = (letter) => letter.repeat(300 * 1024);

test("transactions from two connections never interleave: both row edits are stored", async () => {
  const w = world(SERVED);
  const [a, b] = [await openTab(w, "a"), await openTab(w, "b")];
  await a.sync(); await b.sync();
  a.edit("cards", [{ id: 1, text: "one" }, { id: 2, text: "from a" }]); a.snapshot();
  b.edit("cards", [{ id: 1, text: "one" }, { id: 3, text: "from b" }]); b.snapshot();
  await Promise.all([a.sync(), b.sync()]);
  const ids = (await stored(w)).record.data.cards.map((card) => card.id).sort();
  expectEqual(ids, [1, 2, 3]);
});

test("round 4 finding 1: a follow-up write that undoes an in-flight write keeps the revert", async () => {
  const w = world(SERVED);
  const t = await openTab(w, "t");
  await t.sync();
  t.edit("note", "temporary text I then undo"); t.snapshot();
  const first = t.sync();
  t.edit("note", "owner note"); t.snapshot();
  const second = t.sync();
  await Promise.all([first, second]);
  expectEqual((await stored(w)).record.data.note, "owner note");
  expectEqual(t.page.note, "owner note");
  expectEqual(t.chain.length, 0);
});

test("the same follow-up when the first write fails: both operations land once, in order", async () => {
  const w = world(SERVED);
  const t = await openTab(w, "t");
  await t.sync();
  t.edit("title", "my title"); t.edit("note", "temporary"); t.snapshot({ journal: false });
  const first = t.sync({ fail: true }).catch(() => "failed");
  t.edit("note", "owner note"); t.snapshot({ journal: false });
  const second = t.sync();
  expectEqual(await first, "failed");
  await second;
  const { record, meta } = await stored(w);
  expectEqual([record.data.title, record.data.note], ["my title", "owner note"]);
  expectEqual(meta.tabs.t.seq, 2);
});

test("round 3 finding 1: a failed write, another tab's commit, then the retry keeps both edits", async () => {
  const w = world(SERVED);
  const [t, other] = [await openTab(w, "t"), await openTab(w, "other")];
  await t.sync(); await other.sync();
  t.edit("note", "my note"); t.snapshot({ journal: false });
  await t.sync({ fail: true }).catch(() => {});
  other.edit("title", "other tab title"); other.snapshot(); await other.sync();
  await t.sync();
  const { record, conflict } = await stored(w);
  expectEqual([record.data.title, record.data.note], ["other tab title", "my note"]);
  expectEqual(conflict, null);
  expectEqual(t.page.title, "other tab title");
});

test("round 4 finding 2 (Opus N1, N2): an idle tab's catch-up cannot drop a committed title", async () => {
  for (const order of ["z-first", "x-first"]) {
    const w = world(SERVED);
    const [x, y, z] = [await openTab(w, "x"), await openTab(w, "y"), await openTab(w, "z")];
    await x.sync(); await y.sync(); await z.sync();
    y.edit("title", "title Y"); y.snapshot(); await y.sync();
    x.edit("note", "note X"); x.snapshot();
    if (order === "z-first") { await z.sync(); await x.sync(); } else { await x.sync(); await z.sync(); }
    const { record, meta } = await stored(w);
    expectEqual([record.data.title, record.data.note], ["title Y", "note X"], order);
    expectEqual(meta.rev, 2, order + ": each operation applied exactly once");
    expectEqual([z.page.title, z.page.note], ["title Y", "note X"], order);
    expectEqual(x.chain.length, 0, order);
  }
});

test("exactly once: a journal replayed by two tabs does not undo a later change to the same key", async () => {
  const w = world(SERVED);
  const [dead, u, v] = [await openTab(w, "dead"), await openTab(w, "u"), await openTab(w, "v")];
  await dead.sync(); await u.sync(); await v.sync();
  dead.edit("note", "last words"); dead.snapshot(); dead.die();
  const kept = w.local.get(KEY + ":op:dead");
  await u.sync();
  expectEqual((await stored(w)).record.data.note, "last words");
  u.edit("note", "u changed it later"); u.snapshot(); await u.sync();
  w.local.set(KEY + ":op:dead", kept);
  await v.sync();
  expectEqual((await stored(w)).record.data.note, "u changed it later");
  expectEqual(w.local.has(KEY + ":op:dead"), false);
});

test("round 4 finding 3 (Opus S1): a delayed Start over keeps the new generation's work", async () => {
  const w = world(SERVED);
  const t = await openTab(w, "t");
  await t.sync();
  t.edit("note", "old draft"); t.snapshot(); await t.sync();
  const reset = t.resetBegin();
  const fresh = await openTab(w, "fresh");
  await fresh.sync();
  expectEqual(fresh.gen, 2);
  expectEqual(fresh.page.note, "owner note");
  for (let i = 1; i <= 33; i++) { fresh.edit("title", "Fresh save " + i); if (i === 33) fresh.edit("note", big("n")); fresh.snapshot(); await fresh.sync(); }
  const result = await t.resetCommit(reset);
  expectEqual(result.changed, false);
  const { record, meta } = await stored(w);
  expectEqual(meta.gen, 2);
  expectEqual(record.data.note.length, 300 * 1024);
});

test("Start over never comes back: an unconfirmed write from the old generation is dropped", async () => {
  const w = world(SERVED);
  const [t, late] = [await openTab(w, "t"), await openTab(w, "late")];
  await t.sync(); await late.sync();
  t.edit("note", "draft"); t.snapshot(); await t.sync();
  await late.sync();
  late.edit("title", "typed before I knew"); late.snapshot();
  await t.resetCommit(t.resetBegin());
  await late.sync();
  const { record, meta } = await stored(w);
  expectEqual(record, null);
  expectEqual(meta.gen, 2);
  expectEqual(late.stopped, true);
  expectEqual(w.local.has(KEY + ":op:late"), false);
});

test("a blind row written at hide is folded by another tab, once, with its large key", async () => {
  const w = world(SERVED);
  const [hidden, u] = [await openTab(w, "hidden"), await openTab(w, "u")];
  await hidden.sync(); await u.sync();
  hidden.edit("note", big("h")); hidden.snapshot({ journal: false });
  await hidden.blind();
  u.edit("title", "u title"); u.snapshot(); await u.sync();
  const first = await stored(w);
  expectEqual(first.record.data.note.length, 300 * 1024);
  expectEqual(first.record.data.title, "u title");
  await hidden.sync();
  expectEqual((await stored(w)).meta.rev, first.meta.rev);
  expectEqual(hidden.chain.length, 0);
  expectEqual(hidden.page.title, "u title");
});

test("Opus B1: a save before the first sync does not undo a newer journaled edit", async () => {
  const w = world(SERVED);
  const closed = await openTab(w, "closed");
  await closed.sync();
  closed.edit("title", "title L1"); closed.snapshot(); closed.die();
  const t = await openTab(w, "t");
  t.page.title = "title L1"; t.tip.title = "title L1";
  t.edit("note", "typed at once"); t.snapshot();
  await t.sync();
  const { record } = await stored(w);
  expectEqual([record.data.title, record.data.note], ["title L1", "typed at once"]);
});

test("round 4 finding 1 with no journal: the second transaction skips the landed operation and applies the next", async () => {
  const w = world(SERVED);
  const t = await openTab(w, "t");
  await t.sync();
  t.edit("note", "temporary text I then undo"); t.snapshot({ journal: false });
  const first = t.sync();
  t.edit("note", "owner note"); t.snapshot({ journal: false });
  const second = t.sync();
  await Promise.all([first, second]);
  const { record, meta } = await stored(w);
  expectEqual(record.data.note, "owner note");
  expectEqual(meta.rev, 2);
  expectEqual(t.page.note, "owner note");
});


// Tabs sharing one visitor draft, reduced to what the write model sees: a plain object for
// the page, a Map for localStorage, and the real `transact()` over fake-indexeddb.
// Ported from the design pass prototype (big/20261112-drafts-design/fable-scratch/tabs.mjs);
// the session that does this on a real page is step 2.
import { deserialize, serialize } from "node:v8";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { openDrafts } from "../../../src/plugins/visitor-drafts/idb.js";
import { markerFor, metaKey, rowKey, transact } from "../../../src/plugins/visitor-drafts/commit.js";
import { merge3, same, unitMark } from "../../../src/plugins/visitor-drafts/store.js";

globalThis.structuredClone ??= (value) => deserialize(serialize(value));

const clone = (value) => JSON.parse(JSON.stringify(value));
export const KEY = "clay:visitor-drafts:slot@/";

// What the store hands `commit()` on a real page.
export const TOOLS = { merge3, unitMark };

// The keys `mine` changed from `base`, each with the value before and after.
export function delta(base, mine) {
  const keys = {};
  for (const name of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    if (name in base && name in mine && same(base[name], mine[name])) continue;
    keys[name] = { ...(name in base && { b: clone(base[name]) }), ...(name in mine && { m: clone(mine[name]) }) };
  }
  return keys;
}
const slotPrefix = KEY + ":op:";

export function world(served) {
  let ids = 0;
  return { factory: new IDBFactory(), local: new Map(), served: clone(served), now: Date.parse("2026-11-12T12:00:00Z"), newId: () => "r" + ++ids };
}

const slotsIn = (local) => [...local].filter(([name]) => name.startsWith(slotPrefix)).map(([, text]) => JSON.parse(text));
const open = (w) => openDrafts({ factory: w.factory, keyRange: IDBKeyRange });

// A connection whose transaction can be made to fail after its writes are queued: a value
// IndexedDB cannot clone, put last, aborts it.
function failable(drafts) {
  return {
    ...drafts,
    change(key, build, { fail = false } = {}) {
      return drafts.change(key, (raw) => {
        const planned = build(raw);
        if (fail) planned.puts.push([key + ":poison", () => {}]);
        return planned;
      });
    },
  };
}

function run(w, drafts, input, options) {
  return transact({ change: (key, build) => drafts.change(key, build, options) }, KEY, () => {
    const cached = w.local.get(KEY);
    return {
      ...TOOLS,
      seed: w.served,
      now: w.now,
      newId: w.newId,
      marker: w.local.get(KEY + ":reset") ?? null,
      local: cached ? JSON.parse(cached) : null,
      ...input,
      chains: [...slotsIn(w.local), ...(input.chains ?? [])],
    };
  });
}

export async function openTab(w, id) {
  const drafts = failable(await open(w));
  const tab = {
    id,
    page: clone(w.served),
    tip: clone(w.served),
    gen: 1,
    reset: w.local.get(KEY + ":reset") ?? "",
    rev: 0,
    seq: 0,
    acked: 0,
    chain: [],
    stopped: false,
    edit(name, value) { tab.page[name] = clone(value); },
    carrier() { return { tab: id, reset: tab.reset, acked: tab.acked, ops: tab.chain }; },
    // The synchronous half of a save: the operation, and its journal slot.
    snapshot({ journal = true } = {}) {
      const keys = delta(tab.tip, tab.page);
      if (!Object.keys(keys).length) return null;
      const op = { seq: ++tab.seq, savedAt: new Date(w.now).toISOString(), keys };
      tab.chain.push(op);
      tab.tip = clone(tab.page);
      if (journal) w.local.set(rowKey(KEY, id), JSON.stringify(tab.carrier()));
      return op;
    },
    blind() { return drafts.putRow(rowKey(KEY, id), JSON.stringify(tab.carrier())); },
    sync(options = {}, extra = {}) {
      const chains = tab.chain.length ? [clone(tab.carrier())] : [];
      return run(w, drafts, { chains, ...extra }, options).then((result) => tab.took(result));
    },
    took(result) {
      if (result.meta.reset !== tab.reset && (result.stale.includes(id) || tab.rev > 0 || tab.chain.length)) {
        tab.stopped = true;
        w.local.delete(rowKey(KEY, id));
        return result;
      }
      tab.gen = result.meta.gen;
      tab.reset = result.meta.reset;
      const at = result.meta.tabs[id]?.seq ?? 0;
      tab.acked = Math.max(tab.acked, at);
      tab.chain = tab.chain.filter((op) => op.seq > at);
      for (const [name, text] of [...w.local]) {
        if (!name.startsWith(slotPrefix)) continue;
        const carrier = JSON.parse(text);
        const done = carrier.reset !== result.meta.reset || carrier.ops.every((op) => op.seq <= (result.meta.tabs[carrier.tab]?.seq ?? 0));
        if (done) w.local.delete(name);
      }
      const held = w.local.get(KEY) ? JSON.parse(w.local.get(KEY)) : null;
      const unabsorbed = held && held.w === undefined && held.id !== result.meta.foreign;
      if (!unabsorbed && (!held || held.w === undefined || held.w.rev < result.meta.rev)) {
        if (result.record) w.local.set(KEY, JSON.stringify({ ...result.record, w: { rev: result.meta.rev, reset: result.meta.reset } }));
        else w.local.delete(KEY);
      }
      if (tab.chain.length) return result;
      const theirs = result.record ? result.record.data : w.served;
      tab.page = merge3(tab.tip, tab.page, theirs).value;
      tab.tip = clone(theirs);
      tab.rev = result.meta.rev;
      return result;
    },
    resetBegin(nonce = "n" + Math.random().toString(36).slice(2, 8)) {
      tab.stopped = true;
      const marker = markerFor(tab.gen + 1, nonce);
      w.local.set(KEY + ":reset", marker);
      w.local.delete(rowKey(KEY, id));
      return { ends: tab.gen, marker };
    },
    resetCommit(reset) { return run(w, drafts, { resets: [reset] }); },
    die() { drafts.close(); },
  };
  return tab;
}

export async function stored(w) {
  const drafts = await open(w);
  const all = await drafts.readAll(KEY);
  drafts.close();
  const read = (name) => (all.has(name) ? JSON.parse(all.get(name)) : null);
  return { meta: read(metaKey(KEY)), record: read(KEY), conflict: read(KEY + ":conflict"), all };
}

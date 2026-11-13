/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { openTab, stored, world } from "./helpers/visitor-drafts-tabs.js";

// Random schedules over three tabs: edits, saves, failed transactions, blind rows, closed tabs.
// One tab in three has no journal slot (a draft too large for it) and leaves a blind row when
// it closes. Checked after every step: a tab's page still shows everything that tab saved.
// Checked at the end: every saved operation was applied exactly once, no saved row is missing,
// every tab shows the record, and no conflict copy exists (no two tabs change the same thing).
// Ported from the design pass prototype (fable-scratch/fuzz.test.mjs).
const SERVED = { title: "owner title", cards: [{ id: "base", text: "one" }] };
const random = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

async function schedule(seed, steps = 40) {
  const next = random(seed);
  const pick = (n) => Math.floor(next() * n);
  const w = world(SERVED);
  let born = 0;
  const open = async () => Object.assign(await openTab(w, "t" + ++born), { journal: pick(3) > 0, mine: new Set() });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const tabs = [await open(), await open(), await open()];
  const flying = [];
  const saved = { ops: 0, rows: new Set(), last: new Map() };
  const save = (tab) => {
    const op = tab.snapshot({ journal: tab.journal });
    if (!op) return;
    saved.ops++;
    for (const row of tab.page.cards) if (row.by === tab.id) { saved.rows.add(row.id); tab.mine.add(row.id); }
    if (tab.id in tab.page) saved.last.set(tab.id, tab.page[tab.id]);
  };
  for (let step = 0; step < steps; step++) {
    const at = pick(tabs.length);
    const tab = tabs[at];
    const roll = pick(10);
    if (roll < 3) { tab.edit("cards", [...tab.page.cards, { id: `${tab.id}.${step}`, by: tab.id, text: "row" }]); save(tab); }
    else if (roll < 5) { tab.edit(tab.id, step); save(tab); }
    else if (roll < 7) flying.push(tab.sync().catch(() => {}));
    else if (roll < 8) flying.push(tab.sync({ fail: true }).catch(() => {}));
    else if (roll < 9) flying.push(tab.blind());
    else { await Promise.all(flying.splice(0)); if (!tab.journal) await tab.blind(); tab.die(); tabs[at] = await open(); }
    const pause = pick(6);
    if (pause === 0) await Promise.all(flying.splice(0));
    else if (pause < 4) for (let i = pick(4); i >= 0; i--) await tick();
    for (const live of tabs) {
      const shown = new Set(live.page.cards.map((row) => row.id));
      for (const id of live.mine) if (!shown.has(id)) throw new Error(`seed ${seed}, step ${step}: tab ${live.id} no longer shows its own row ${id}`);
      if (saved.last.has(live.id) && live.page[live.id] !== saved.last.get(live.id)) throw new Error(`seed ${seed}, step ${step}: tab ${live.id} lost its own value`);
    }
  }
  await Promise.all(flying.splice(0));
  for (const tab of tabs) await tab.sync();
  for (const tab of tabs) await tab.sync();
  const { meta, record, conflict } = await stored(w);
  return { saved, meta, record, conflict, tabs };
}

test("400 random schedules: every saved operation applied exactly once, every saved row stored, all tabs agree", async () => {
  let ops = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const { saved, meta, record, conflict, tabs } = await schedule(seed);
    ops += saved.ops;
    expect({ seed, applied: meta.rev }).toEqual({ seed, applied: saved.ops });
    expect({ seed, conflict }).toEqual({ seed, conflict: null });
    const ids = new Set((record?.data.cards ?? []).map((row) => row.id));
    for (const id of saved.rows) expect({ seed, id, stored: ids.has(id) }).toEqual({ seed, id, stored: true });
    for (const [name, value] of saved.last) expect({ seed, name, value: record.data[name] }).toEqual({ seed, name, value });
    for (const tab of tabs) expect({ seed, tab: tab.id, page: tab.page }).toEqual({ seed, tab: tab.id, page: record ? record.data : SERVED });
  }
  expect(ops).toBeGreaterThan(3000);
}, 120000);

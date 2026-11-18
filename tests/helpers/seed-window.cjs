const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 86400000;

function depthOf(env = process.env) {
  const asked = env.TEST_DEPTH;
  if (asked === 'full' || asked === 'routine') return asked;
  if (asked) throw new Error(`TEST_DEPTH must be full or routine, not ${JSON.stringify(asked)}`);
  return env.TESTBOX === '1' || env.CI ? 'full' : 'routine';
}

function parsePinned(text) {
  const seeds = [];
  for (const part of String(text).split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!match) throw new Error(`TEST_SEEDS must look like 7, 3-9 or 2,5,11, not ${JSON.stringify(text)}`);
    const to = match[2] === undefined ? Number(match[1]) : Number(match[2]);
    for (let seed = Number(match[1]); seed <= to; seed += 1) seeds.push(seed);
  }
  return seeds;
}

function dayOf(env, now) {
  const day = env.TEST_SEED_DAY || new Date(now).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`TEST_SEED_DAY must be YYYY-MM-DD, not ${JSON.stringify(day)}`);
  return { day, index: Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS) };
}

function record(env, entry) {
  if (env.TESTBOX_OUT) fs.appendFileSync(path.join(env.TESTBOX_OUT, 'seed-windows.jsonl'), `${JSON.stringify(entry)}\n`);
}

function pick(items, { name, routine, keep, env, now }) {
  if (depthOf(env) === 'full' || routine >= items.length) {
    record(env, { name, depth: 'full', count: items.length });
    return { items: [...items], depth: 'full' };
  }
  const { day, index } = dayOf(env, now);
  const windows = Math.ceil(items.length / routine);
  const at = ((index % windows) + windows) % windows;
  const slice = items.slice(at * routine, (at + 1) * routine);
  const chosen = items.filter((item) => slice.includes(item) || keep.includes(item));
  record(env, { name, depth: 'routine', count: chosen.length, day });
  return { items: chosen, depth: 'routine', slice, window: `${at + 1}/${windows}`, day };
}

function windowOf(items, { name, routine, keep = [], env = process.env, now = Date.now() }) {
  const picked = pick(items, { name, routine, keep, env, now });
  const label = picked.depth === 'full'
    ? `${name}: all ${items.length}`
    : `${name}: window ${picked.window} for ${picked.day}; TEST_DEPTH=full runs all`;
  return { items: picked.items, depth: picked.depth, label };
}

function seedWindow({ name, full, routine, keep = [], env = process.env, now = Date.now() }) {
  if (env.TEST_SEEDS) {
    const seeds = parsePinned(env.TEST_SEEDS);
    record(env, { name, depth: 'pinned', count: seeds.length });
    return { seeds, depth: 'pinned', label: `${name}: pinned seeds ${env.TEST_SEEDS}` };
  }
  const all = Array.from({ length: full }, (_, i) => i + 1);
  const picked = pick(all, { name, routine, keep, env, now });
  if (picked.depth === 'full') {
    return { seeds: picked.items, depth: 'full', label: `${name}: all ${full} seeds; TEST_SEEDS=<n> reruns one` };
  }
  const kept = picked.items.filter((seed) => !picked.slice.includes(seed));
  const plus = kept.length ? ` plus kept ${kept.join(',')}` : '';
  return {
    seeds: picked.items,
    depth: 'routine',
    label: `${name}: seeds ${picked.slice[0]}-${picked.slice.at(-1)} of 1-${full}${plus} (window ${picked.window}, ${picked.day}); TEST_DEPTH=full runs all, TEST_SEEDS=<n> reruns one`,
  };
}

function countOf({ name, full, routine, env = process.env }) {
  const depth = depthOf(env) === 'full' || routine >= full ? 'full' : 'routine';
  const count = depth === 'full' ? full : routine;
  record(env, { name, depth, count });
  return { count, depth, label: depth === 'full' ? `${name}: all ${full}` : `${name}: ${routine} of ${full}; TEST_DEPTH=full runs all` };
}

module.exports = { seedWindow, windowOf, countOf, depthOf, parsePinned };

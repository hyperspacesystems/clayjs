const pad = (n) => n.toString(36).padStart(8, "0");
const mk = (n, id) => `${pad(n)}_${id}`;
const cnt = (s) => parseInt(s.slice(0, 8), 36);
const ZERO = mk(0, "0");
const clone = (v) => structuredClone(v);
const PLANT = process.env.PLANT || "";
const TRACE = process.env.TRACE || "";
const KEEP = Number(process.env.KEEP || 2);
const WATCH = process.env.WATCH || "";
const UNION = process.env.UNION === "1";
const W = Number(process.env.W || 4);
const STRICT_ACK = process.env.STRICT_ACK === "1";
const NO_FRONT = process.env.NO_FRONT === "1";
const NO_SWEEP = process.env.NO_SWEEP === "1";
const note = (...a) => { if (TRACE) console.log(...a); };

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIELDS = [];
for (let r = 1; r <= 4; r++) for (let c = 1; c <= 3; c++) FIELDS.push(`r${r}/c${c}`);

const emptyStore = () => ({ revs: {}, patches: {} });
function baseOf(store) {
  let b = ZERO;
  for (const [rev, rec] of Object.entries(store.revs)) if (rec.done && rev > b) b = rev;
  return b;
}
function inertStamps(store) {
  const set = new Set();
  if (!UNION || process.env.NO_RB === "1") return set;
  const ok = new Set([...Object.keys(store.revs), baseOf(store)]);
  for (const rec of Object.values(store.revs)) ok.add(rec.prev);
  for (const [s, patch] of Object.entries(store.patches)) if (patch.rb && !ok.has(patch.rb)) set.add(s);
  return set;
}
function skipStamps(store) {
  const set = doneStamps(store);
  for (const s of inertStamps(store)) set.add(s);
  return set;
}
function doneStamps(store) {
  const set = new Set();
  for (const rec of Object.values(store.revs)) if (rec.done) for (const s of rec.stamps || []) set.add(s);
  return set;
}
function applyOp(store, op) {
  let o = store;
  const p = op.p;
  for (let i = 0; i < p.length - 1; i++) {
    if (o[p[i]] == null) {
      if (op.k === "del") return;
      o[p[i]] = {};
    }
    o = o[p[i]];
  }
  if (op.k === "set") o[p.at(-1)] = clone(op.v);
  else delete o[p.at(-1)];
}

function materialize(shadow, patches, skip) {
  const cells = { ...shadow };
  const win = {};
  for (const s of Object.keys(patches)) {
    if (skip.has(s)) continue;
    for (const [f, v] of Object.entries(patches[s].cells)) if (!win[f] || s > win[f]) { win[f] = s; cells[f] = v; }
  }
  return cells;
}
const same = (a, b) => JSON.stringify(Object.entries(a).filter(([, v]) => v != null).sort()) === JSON.stringify(Object.entries(b).filter(([, v]) => v != null).sort());

function newTab(id) {
  return { id, counter: 0, rev: ZERO, cells: {}, origin: {}, applied: new Map(), winners: new Map(), authored: new Map(), local: emptyStore(), auth: emptyStore(), sent: [], out: [], cursor: 0, connected: true, alive: true, known: 0, fileRev: ZERO, save: null, shadow: {}, recs: [], accepted: null, under: new Map(), redo: null, stuck: false, notices: 0 };
}

function applyPatch(tab, s, patch) {
  tab.applied.set(s, patch);
  tab.counter = Math.max(tab.counter, cnt(s));
  for (const [f, v] of Object.entries(patch.cells)) {
    const w = tab.winners.get(f);
    const wins = PLANT === "arrival-wins" ? true : !w || s > w;
    if (!w) tab.under.set(f, { v: tab.cells[f], o: tab.origin[f] });
    if (wins) { tab.winners.set(f, s); tab.cells[f] = v; tab.origin[f] = s; }
  }
}
function bestFor(tab, f) {
  let best = null;
  for (const [t, p] of tab.applied) if (f in p.cells && (!best || t > best)) best = t;
  return best;
}
function unapply(tab, s) {
  const patch = tab.applied.get(s);
  if (!patch) return;
  tab.applied.delete(s);
  for (const f of Object.keys(patch.cells)) {
    const best = bestFor(tab, f);
    if (best) { tab.winners.set(f, best); tab.cells[f] = tab.applied.get(best).cells[f]; tab.origin[f] = best; continue; }
    const u = tab.under.get(f);
    tab.winners.delete(f);
    tab.cells[f] = u?.v;
    tab.origin[f] = u?.o;
    tab.under.delete(f);
  }
}
function trim(tab, stamps) {
  const top = new Map();
  for (const s of stamps) {
    const patch = tab.applied.get(s);
    if (!patch) continue;
    for (const f of Object.keys(patch.cells)) if (!top.has(f) || s > top.get(f).s) top.set(f, { s, v: patch.cells[f] });
  }
  for (const s of stamps) tab.applied.delete(s);
  for (const [f, { s, v }] of top) {
    const best = bestFor(tab, f);
    if (best) { tab.under.set(f, { v, o: s }); tab.winners.set(f, best); tab.cells[f] = tab.applied.get(best).cells[f]; tab.origin[f] = best; }
    else { tab.under.delete(f); tab.winners.delete(f); tab.cells[f] = v; tab.origin[f] = s; }
  }
}
function view(tab) {
  tab.local = clone(tab.auth);
  for (const ops of tab.sent) for (const op of ops) applyOp(tab.local, op);
  for (const ops of tab.out) for (const op of ops) applyOp(tab.local, op);
}
function sendFront(tab, ops) {
  if (!UNION || NO_FRONT) return send(tab, ops);
  tab.front = tab.front || 0;
  tab.out.splice(tab.front, 0, ops);
  tab.front++;
  view(tab);
}
function send(tab, ops) {
  for (const op of ops) applyOp(tab.local, op);
  tab.out.push(ops);
}
function edit(world, tab, field, value, replays = null) {
  const s = mk(++tab.counter, tab.id);
  world.edits.set(s, { s, field, value, prior: tab.origin[field] || null, replays });
  if (field === TRACE) note("edit", tab.id, s, value, "prior", tab.origin[field], "rev", tab.rev);
  tab.authored.set(s, { field, value, before: tab.cells[field] ?? null });
  applyPatch(tab, s, { by: tab.id, cells: { [field]: value } });
  send(tab, [{ k: "set", p: ["patches", s], v: { by: tab.id, cells: { [field]: value } } }]);
}

function complete(tab, rev, rec) {
  const ops = [{ k: "set", p: ["revs", rev], v: { prev: rec.prev, stamps: rec.stamps, done: true } }];
  for (const s of rec.stamps) ops.push({ k: "del", p: ["patches", s] });
  if (PLANT === "trim-by-counter") {
    const hi = rec.stamps.reduce((m, s) => (s > m ? s : m), "");
    for (const s of Object.keys(tab.local.patches)) if (s <= hi && !rec.stamps.includes(s)) ops.push({ k: "del", p: ["patches", s] });
  }
  if (UNION) {
    const keep = [...new Set([...Object.keys(tab.local.revs), rev])].sort().slice(-W);
    for (const other of Object.keys(tab.local.revs)) if (other < rev && !keep.includes(other)) ops.push({ k: "del", p: ["revs", other] });
    if (!NO_SWEEP) {
      const listed = new Set(rec.stamps);
      for (const k of keep) for (const s of tab.local.revs[k]?.stamps || []) listed.add(s);
      const inertNow = inertStamps(tab.local);
      for (const s of Object.keys(tab.local.patches)) if ((listed.has(s) || inertNow.has(s)) && !rec.stamps.includes(s)) ops.push({ k: "del", p: ["patches", s] });
    }
  } else {
    for (const other of Object.keys(tab.local.revs)) if (other < rev) ops.push({ k: "del", p: ["revs", other] });
  }
  sendFront(tab, ops);
}
function advance(tab, rev, rec) {
  const part = {};
  for (const s of rec.stamps) part[s] = tab.applied.get(s);
  for (const s of rec.stamps) if (TRACE in part[s].cells) note("advance", tab.id, "to", rev, "drops", s);
  tab.shadow = materialize(tab.shadow, part, new Set());
  trim(tab, rec.stamps);
  tab.rev = rev;
  tab.recs = [...tab.recs.filter((r) => r.rev !== rev), { rev, prev: rec.prev, stamps: rec.stamps }].slice(-KEEP);
  if (tab.accepted && tab.accepted.rev === rev) tab.accepted = null;
}
function load(tab, file) {
  tab.cells = clone(file.cells);
  tab.origin = clone(file.origin);
  tab.shadow = clone(file.cells);
  tab.rev = file.rev;
  tab.fileRev = file.rev;
  tab.applied.clear();
  tab.winners.clear();
  tab.under.clear();
  tab.recs = clone(file.recs);
  tab.accepted = null;
}
function refetch(world, tab) {
  const file = world.host.file;
  tab.known = world.host.version;
  tab.fileRev = file.rev;
  if (file.rev === tab.rev) return false;
  const ahead = file.recs.at(-1);
  if (ahead && ahead.rev === file.rev && ahead.prev === tab.rev && baseOf(tab.local) === tab.rev && ahead.stamps.every((s) => tab.applied.has(s))) {
    complete(tab, file.rev, ahead);
    return true;
  }
  let keep = [];
  if (UNION && process.env.NO_KEEP !== "1") {
    const all = new Map();
    for (const r of [...(file.recs || []), ...tab.recs]) all.set(r.rev, r);
    for (const [rev, r] of Object.entries(tab.local.revs)) all.set(rev, { rev, prev: r.prev, stamps: r.stamps });
    for (const [rev, r] of Object.entries(file.tag?.revs || {})) all.set(rev, { rev, prev: r.prev, stamps: r.stamps });
    const listed = new Set();
    let cur = file.rev;
    let ok = false;
    for (let i = 0; i < 64; i++) {
      if (cur === tab.rev) { ok = true; break; }
      const r = all.get(cur);
      if (!r) break;
      for (const x of r.stamps) listed.add(x);
      cur = r.prev;
    }
    if (ok) keep = [...tab.applied].filter(([x]) => !listed.has(x));
  }
  const kept = new Set(keep.map(([x]) => x));
  const mine = [...tab.authored].filter(([s]) => tab.applied.has(s) && !(s in tab.local.patches) && !kept.has(s)).sort();
  load(tab, file);
  for (const [x, patch] of keep) applyPatch(tab, x, patch);
  note("adopt", tab.id, "file", file.rev, TRACE, tab.cells[TRACE], "mine", mine.map(([m]) => m).join(","), "keeps", keep.length);
  world.refetches++;
  tab.redo = mine.map(([m, e]) => ({ s: m, ...e }));
  return true;
}
function reconcile(world, tab) {
  for (let guard = 0; guard < 8; guard++) {
    const st = tab.local;
    const base = baseOf(st);
    if (base === tab.rev) {
      const done = doneStamps(st);
      const had = new Set(tab.applied.keys());
      const inert = inertStamps(st);
      const missing = [...tab.applied.keys()].filter((x) => (!(x in st.patches) || inert.has(x)) && !done.has(x)).sort();
      const shown = [];
      if (UNION) {
        const back = missing.map((x) => ({ k: "set", p: ["patches", x], v: { ...tab.applied.get(x), rb: tab.rev } }));
        if (back.length) {
          sendFront(tab, back);
        }
      } else if (PLANT === "put-back") {
        const back = missing.map((x) => ({ k: "set", p: ["patches", x], v: tab.applied.get(x) }));
        if (back.length) send(tab, back);
      } else {
        for (const x of missing) {
          const e = tab.authored.get(x);
          if (e && tab.winners.get(e.field) === x) shown.push({ s: x, ...e });
        }
        for (const x of missing.reverse()) unapply(tab, x);
      }
      trim(tab, [...tab.applied.keys()].filter((x) => done.has(x)));
      for (const x of Object.keys(st.patches).sort()) if (!tab.applied.has(x) && !done.has(x) && !inert.has(x)) applyPatch(tab, x, st.patches[x]);
      for (const e of shown) {
        const cur = tab.winners.get(e.field);
        if ((tab.cells[e.field] ?? null) === e.value) continue;
        if (!cur || had.has(cur) || cur < e.s) edit(world, tab, e.field, e.value, e.s);
        else tab.notices++;
      }
      if (tab.redo) {
        const redo = tab.redo;
        tab.redo = null;
        for (const e of redo) {
          const now = tab.cells[e.field] ?? null;
          if (now === e.value) continue;
          if (PLANT === "resend-uncertain") { edit(world, tab, e.field, e.value, e.s); continue; }
          if (now === e.before) edit(world, tab, e.field, e.value, e.s);
          else tab.notices++;
        }
      }
      if (tab.accepted && tab.accepted.prev === base) { complete(tab, tab.accepted.rev, tab.accepted); continue; }
      tab.stuck = false;
      return;
    }
    const nextKey = UNION ? Object.keys(st.revs).sort().find((r) => r > tab.rev && st.revs[r].done && st.revs[r].prev === tab.rev) : base;
    const rec = nextKey ? st.revs[nextKey] : null;
    if (rec && rec.done && rec.prev === tab.rev && rec.stamps.every((s) => tab.applied.has(s))) { advance(tab, nextKey, rec); continue; }
    const known = tab.recs.find((r) => r.prev === base);
    if (known) { complete(tab, known.rev, known); continue; }
    if (!refetch(world, tab)) break;
  }
  tab.stuck = true;
}

function checkpoint(world, tab) {
  if (tab.save || !tab.connected || tab.accepted || tab.stale) return;
  if (PLANT !== "writer-skips-etag" && tab.known !== world.host.version) catchUp(world, tab);
  reconcile(world, tab);
  if (PLANT !== "capture-early" && (tab.out.length || tab.sent.length)) return;
  const st = tab.local;
  const base = baseOf(st);
  if (tab.stuck || base !== tab.rev) return;
  const done = doneStamps(st);
  const inertNow = inertStamps(st);
  const stamps = Object.keys(st.patches).filter((s) => !done.has(s) && !inertNow.has(s)).sort();
  if (!stamps.length) {
    const sweep = Object.keys(st.patches).filter((s) => done.has(s) || inertNow.has(s));
    if (UNION && sweep.length) send(tab, sweep.map((s) => ({ k: "del", p: ["patches", s] })));
    return;
  }
  const rev = mk(Math.max(cnt(tab.rev), cnt(base), cnt(tab.fileRev)) + 1, tab.id);
  note("capture", tab.id, rev, "prev", base, "takes", stamps.filter((x) => TRACE in st.patches[x].cells).join(","), TRACE, tab.cells[TRACE]);
  const recs = [...tab.recs.filter((r) => r.rev === base), { rev, prev: base, stamps }].slice(-KEEP);
  tab.save = { file: { rev, recs, cells: clone(tab.cells), origin: clone(tab.origin), tag: clone(tab.local) }, known: tab.known };
  world.inflight.push(tab);
}
function hostAnswer(world, tab, force) {
  const { file, known } = tab.save;
  tab.save = null;
  const ok = known === world.host.version && force !== false;
  if (ok) {
    world.host.file = file;
    world.host.version++;
    world.accepted++;
    {
      const pad = (x) => x.replace(/_(t\d+)$/, (m, id) => "_" + id.padEnd(16, "x"));
      const revs = file.tag.revs;
      const recs = file.recs;
      const text = JSON.stringify({ revs, recs });
      const padded = text.replace(/"([0-9a-z]{8})_(t\d+)"/g, (m, c, id) => `"${c}_${id.padEnd(16, "x")}"`);
      const grouped = (rs) => Object.entries(rs).map(([rev, r]) => {
        const by = {};
        for (const st of r.stamps) { const [c, id] = st.split("_"); (by[id.padEnd(16, "x")] ||= []).push(parseInt(c, 36).toString(36)); }
        const g = {};
        for (const [id, list] of Object.entries(by)) g[id] = list.join(",");
        return [rev.replace(/_(t\d+)$/, (m, id) => "_" + id.padEnd(16, "x")), r.prev.replace(/_(t\d+)$/, (m, id) => "_" + id.padEnd(16, "x")), g];
      });
      const recsObj = Object.fromEntries((recs || []).map((r) => [r.rev, r]));
      const compact = JSON.stringify(grouped(revs)).length + JSON.stringify(grouped(recsObj)).length + 2 * 12;
      world.maxCompact = Math.max(world.maxCompact || 0, compact);
      world.maxMeta = Math.max(world.maxMeta || 0, text.length);
      world.maxMetaPadded = Math.max(world.maxMetaPadded || 0, padded.length);
      const per = Object.values(revs).map((r) => r.stamps.length);
      world.maxStamps = Math.max(world.maxStamps || 0, per.reduce((a, b) => a + b, 0));
    }
    for (const x of file.recs.at(-1).stamps) { world.durable.add(x); world.hooks?.durable(x); }
    note("accepted", tab.id, file.rev, "alive", tab.alive);
    if (!tab.alive) return;
    tab.known = world.host.version;
    tab.fileRev = file.rev;
    tab.accepted = clone(file.recs.at(-1));
    if (tab.connected) reconcile(world, tab);
    return;
  }
  world.refused++;
  if (!tab.alive) return;
  if (PLANT === "retry-without-fetch") { tab.known = world.host.version; return; }
  tab.stale = true;
  if (tab.connected) catchUp(world, tab);
}
function catchUp(world, tab) {
  tab.stale = false;
  if (world.host.file.rev !== tab.rev) refetch(world, tab);
  tab.known = world.host.version;
  tab.fileRev = world.host.file.rev;
  reconcile(world, tab);
}

function toRoom(world, tab) {
  if (!tab.connected || !tab.out.length || !world.room) return false;
  const ops = tab.out.shift();
  if (tab.front) tab.front--;
  tab.sent.push(ops);
  for (const op of ops) {
    applyOp(world.room.S, op);
    if (op.k === "set" && op.p[0] === "patches") { world.acked.add(op.p[1]); world.pending?.delete(op.p[1]); world.hooks?.shared(op.p[1]); }
    if (WATCH && op.p[1] === WATCH) note("room", op.k, WATCH, "from", tab.id, "tab rev", tab.rev, "S base", baseOf(world.room.S));
    if (WATCH && op.k === "set" && op.p[0] === "revs") note("room rev", op.p[1], "from", tab.id, "stamps", op.v.stamps.length);
  }
  world.room.log.push({ from: tab.id, ops });
  return true;
}
function toTab(world, tab) {
  if (!tab.connected || !world.room || tab.cursor >= world.room.log.length) return false;
  const frame = world.room.log[tab.cursor++];
  for (const op of frame.ops) applyOp(tab.auth, op);
  if (frame.from === tab.id) tab.sent.shift();
  view(tab);
  if (frame.from !== tab.id) reconcile(world, tab);
  return true;
}
function resync(world, tab) {
  note("resync", tab.id, "rev", tab.rev, "S base", baseOf(world.room.S));
  tab.auth = clone(world.room.S);
  tab.sent = [];
  view(tab);
  tab.cursor = world.room.log.length;
  if (tab.stale) catchUp(world, tab);
  else reconcile(world, tab);
}
function join(world) {
  const tab = newTab(`t${++world.ids}`);
  note("join", tab.id, "file", world.host.file.rev, "room", world.room ? baseOf(world.room.S) : "none");
  const file = world.host.file;
  tab.known = world.host.version;
  if (!world.room) world.room = { S: clone(file.tag), log: [] };
  tab.auth = clone(world.room.S);
  view(tab);
  tab.cursor = world.room.log.length;
  load(tab, file);
  reconcile(world, tab);
  world.tabs.push(tab);
  return tab;
}
function roomLoss(world) {
  note("roomloss", "file", world.host.file.rev, "tag base", baseOf(world.host.file.tag), "S base", baseOf(world.room.S));
  world.room = { S: clone(world.host.file.tag), log: [] };
  world.hooks?.roomGone(Object.keys(world.room.S.patches));
  if (WATCH) note("restart has", WATCH, WATCH in world.room.S.patches, "revs", Object.keys(world.room.S.revs).join(","));
  const held = new Map();
  if (STRICT_ACK) for (const t of world.tabs) if (t.alive && t.connected) for (const s of t.applied.keys()) { if (!held.has(s)) held.set(s, new Set()); held.get(s).add(t); }
  const base = new Set([...world.durable, ...Object.keys(world.room.S.patches)]);
  world.pending = world.pending || new Map();
  for (const s of world.acked) if (!base.has(s) && held.has(s)) world.pending.set(s, new Set([...(world.pending.get(s) || []), ...held.get(s)]));
  world.acked = new Set([...base, ...[...world.acked].filter((s) => held.has(s))]);
  for (const tab of world.tabs) if (tab.alive && tab.connected) resync(world, tab);
  world.losses++;
}

function checkOne(world, tab, where) {
  if (!tab.alive || !tab.connected || tab.stuck) return;
  if (baseOf(tab.local) !== tab.rev) return;
  const want = materialize(tab.shadow, tab.local.patches, skipStamps(tab.local));
  if (!same(want, tab.cells)) throw new Error(`I1 ${tab.id} ${where}: ${JSON.stringify(want)} vs ${JSON.stringify(tab.cells)}`);
}

function run(seed, steps) {
  const rnd = rng(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const world = { host: { file: { rev: ZERO, recs: [], cells: {}, origin: {}, tag: emptyStore() }, version: 0 }, room: null, tabs: [], ids: 0, edits: new Map(), acked: new Set(), durable: new Set(), inflight: [], refetches: 0, accepted: 0, refused: 0, losses: 0 };
  join(world); join(world);
  let value = 0;
  const live = () => world.tabs.filter((t) => t.alive);
  const writer = () => live().find((t) => t.connected) || null;
  for (let i = 0; i < steps; i++) {
    const x = rnd();
    const tabs = live();
    if (!tabs.length) { if (world.room) world.acked = new Set([...world.durable, ...Object.keys(world.host.file.tag.patches)]); world.room = null; join(world); continue; }
    const tab = pick(tabs);
    if (x < 0.34) edit(world, tab, pick(FIELDS), `v${++value}`);
    else if (x < 0.54) toRoom(world, tab);
    else if (x < 0.78) toTab(world, tab);
    else if (x < 0.82) { if (tab.connected) tab.connected = false; else { tab.connected = true; resync(world, tab); } }
    else if (x < 0.88) { const w = writer(); if (w) { if (rnd() < 0.6) { while (toRoom(world, w)); while (toTab(world, w)); } checkpoint(world, w); } }
    else if (x < 0.94) { if (world.inflight.length) hostAnswer(world, world.inflight.shift(), rnd() < 0.15 ? false : undefined); }
    else if (x < 0.96) { if (tabs.length < 5) join(world); }
    else if (x < 0.98) {
      if (tabs.length > 1) { tab.alive = false; tab.connected = false; }
      else if (rnd() < 0.5) {
        while (toRoom(world, tab));
        tab.alive = false; tab.connected = false;
        if (rnd() < 0.5) { world.host.file = { ...world.host.file, tag: clone(world.room.S) }; world.host.version++; }
        world.acked = new Set([...world.durable, ...Object.keys(world.host.file.tag.patches)]);
        world.room = null;
      }
    }
    else if (x < 0.99) roomLoss(world);
    for (const t of world.tabs) checkOne(world, t, `step ${i}`);
  }
  settle(world);
  return verdict(world);
}

function settle(world) {
  const live = () => world.tabs.filter((t) => t.alive);
  const writer = () => live().find((t) => t.connected) || null;
  if (!live().length) { if (world.room) world.acked = new Set([...world.durable, ...Object.keys(world.host.file.tag.patches)]); world.room = null; join(world); }
  for (const t of live()) if (!t.connected) { t.connected = true; resync(world, t); }
  const drain = () => { let moved = true; while (moved) { moved = false; for (const t of live()) { while (toRoom(world, t)) moved = true; } for (const t of live()) { while (toTab(world, t)) moved = true; } } };
  for (let round = 0; round < 6; round++) {
    drain();
    while (world.inflight.length) hostAnswer(world, world.inflight.shift());
    drain();
    for (const t of live()) reconcile(world, t);
    drain();
    const w = writer();
    checkpoint(world, w);
  }
  drain();
  while (world.inflight.length) hostAnswer(world, world.inflight.shift());
  drain();
}

function verdict(world) {
  const live = () => world.tabs.filter((t) => t.alive);
  const tabs = live();
  for (const [s, holders] of world.pending || []) if (![...holders].some((t) => t.alive)) world.acked.delete(s);
  for (const t of tabs) if (t.stuck) throw new Error(`I8 stuck ${t.id} rev ${t.rev} base ${baseOf(t.local)} file ${world.host.file.rev}`);
  for (const t of tabs) checkOne(world, t, "end");
  for (const t of tabs) if (!same(t.cells, tabs[0].cells)) throw new Error(`I2 ${t.id} differs from ${tabs[0].id}`);
  const fresh = join(world);
  if (fresh.stuck) throw new Error("I8 joiner stuck");
  if (!same(fresh.cells, tabs[0].cells)) throw new Error(`I2 joiner differs: ${JSON.stringify(fresh.cells)} vs ${JSON.stringify(tabs[0].cells)}`);
  const left = Object.keys(world.room.S.patches).filter((s) => !doneStamps(world.room.S).has(s));
  if (left.length) throw new Error(`I7 ${left.length} patches left ${process.env.DBG ? JSON.stringify({ left: left.map((x) => [x, world.room.S.patches[x].rb ?? null, inertStamps(world.room.S).has(x)]), revs: Object.keys(world.room.S.revs), holders: live().map((t) => [t.id, t.rev, left.filter((x) => t.applied.has(x)).length]) }) : ""}`);
  const follows = (e, target) => { for (let p = e.prior, n = 0; p && n < 10000; n++) { if (p === target) return true; p = world.edits.get(p)?.prior; } return false; };
  for (const f of FIELDS) {
    const final = tabs[0].origin[f] || null;
    const acked = [...world.edits.values()].filter((e) => e.field === f && world.acked.has(e.s));
    if (!final) { if (acked.length) throw new Error(`I3 ${f}: ${acked.length} acked edits, none kept`); continue; }
    if ((tabs[0].cells[f] ?? null) !== world.edits.get(final).value) throw new Error(`I3 ${f}: value does not match its origin`);
    for (const e of acked) if (e.s !== final && follows(e, final)) throw new Error(`I3 ${f}: ${final} kept, but acked ${e.s} came after it`);
  }
  for (const e of world.edits.values()) if (e.replays && world.acked.has(e.s) && follows(e, e.replays)) throw new Error(`I9 ${e.field}: ${e.s} replays ${e.replays} over an edit that was built on it`);
  return world;
}

export { rng, FIELDS, ZERO, UNION, STRICT_ACK, clone, same, emptyStore, baseOf, doneStamps, edit, toRoom, toTab, resync, checkpoint, hostAnswer, join, roomLoss, checkOne, run, settle, verdict };

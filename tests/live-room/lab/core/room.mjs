import { planted } from "./planted.mjs";
import { applyFrame, resolved, covered, epochOf, W } from "./ledger.mjs";
import { entryBytes, ledgerBytes, recordBudget } from "./record.mjs";
import { frameBytes, opsOf } from "./limits.mjs";
import { assemble } from "./frames.mjs";
import { weigh, remember, counts, newMemory, positions, rowMayReturn } from "./recover.mjs";
import { conflicts, fitsNow, stillOpen, unseenBy, removesOf } from "./conflict.mjs";
import { clone } from "./lib.mjs";

export const stateReserve = (limits) => recordBudget(limits.ledgerCap, W);

export const tailBudget = (limits) => limits.storeBytes - stateReserve(limits);

export const newInstance = (env) => ({ id: `i${env.port.next("instances")}`, gen: null, state: null, base: null, seq: 0, log: [], floor: 0, wait: new Map(), staging: new Map(), restores: new Map(), answered: new Map(), settled: new Set(), bytes: { tail: 0, staged: 0, waiting: 0 } });

export function newRoom(record, etag, state, id) {
  return {
    id,
    gen: record.gen,
    epoch: record.epoch,
    base: { commit: record.commit, etag, through: record.through },
    state: clone(state),
    seq: record.through,
    log: [],
    floor: 0,
    wait: new Map(),
    staging: new Map(),
    restores: new Map(),
    answered: new Map(),
    settled: new Set(),
    removals: [],
    bytes: { tail: 0, staged: 0, waiting: 0 },
  };
}

export const retained = (room) => room.log.slice(room.floor);

export const originOf = (frame) => frame.origin ?? (frame.copy ? [frame.copy[0], frame.e] : frame.take ? [frame.take[0], frame.take[2]] : null);

const inRoom = (env, room, extra) => stateReserve(env.limits) + room.bytes.tail + room.bytes.staged + room.bytes.waiting + extra <= env.limits.roomBytes;

const next = (room, order) => (order.from ? (covered(room.state, order.from)?.[1] ?? -2) + 1 === order.n : resolved(room.state, order.c) === order.p);

function shed(env, room) {
  for (const [key, stage] of room.staging) {
    if (next(room, stage.order)) continue;
    room.staging.delete(key);
    room.bytes.staged -= stage.size;
    env.port.onFull(stage.by);
  }
  for (const waiting of room.wait.values()) {
    for (const [p, entry] of waiting) {
      waiting.delete(p);
      room.bytes.waiting -= entry.bytes;
      env.port.onFull(entry.by);
    }
  }
}

function makeRoom(env, room, bytes) {
  if (!inRoom(env, room, bytes)) shed(env, room);
  return inRoom(env, room, bytes);
}

const full = (env, room, bytes) => !planted("no-tail-cap") && (room.bytes.tail + bytes > tailBudget(env.limits) || !makeRoom(env, room, bytes));

const unknown = (room, client) => !(client in room.state.seen);

function ledgerFull(env, room, client, n) {
  if (planted("no-ledger-cap") || resolved(room.state, client) >= n) return false;
  if (planted("ledger-cap-new-clients-only") && !unknown(room, client)) return false;
  const now = unknown(room, client) ? 0 : entryBytes(client, room.state.seen[client]);
  return ledgerBytes(room.state.seen) - now + entryBytes(client, [n, room.epoch]) > env.limits.ledgerCap;
}

function append(env, room, frame, sent, by) {
  frame.no = room.log.length;
  room.log.push(frame);
  if (frame.k === "receipt") return;
  frame.bytes = frameBytes(frame.action, frame);
  frame.parts = Math.ceil(opsOf(frame.action) / env.limits.opsPerFrame);
  room.bytes.tail += frame.bytes;
  const origin = env.removals && removesOf(frame.action).length > 0 && !frame.keep ? originOf(frame) : null;
  const removed = origin ? unseenBy(room.state.wb, frame.action, frame.saw) : [];
  const result = applyFrame(room.state, frame, room.epoch);
  if (result.applied && removed.length) room.removals.push({ copy: origin[0], by: frame.e, at: [room.gen, frame.seq], cells: removed });
  if (!frame.open && (!result.dup || planted("skipped-frame-settles-an-open-edit"))) room.settled.add(frame.e);
  env.observer.onAdmit(env, room, frame, result, sent, by);
}

function park(room, frame, by, bytes) {
  if (!room.wait.has(frame.c)) room.wait.set(frame.c, new Map());
  const waiting = room.wait.get(frame.c);
  room.bytes.waiting += bytes - (waiting.get(frame.p)?.bytes ?? 0);
  waiting.set(frame.p, { frame, by, bytes });
}

const due = (frame, known) => (planted("parked-request-waits-for-its-exact-count") ? frame.p === known : frame.p <= known + (planted("parked-request-leaves-one-early") ? 1 : 0));

function wake(env, room, client) {
  const waiting = room.wait.get(client);
  const known = resolved(room.state, client);
  const parked = [...(waiting?.values() ?? [])].sort((a, b) => a.frame.n - b.frame.n).find(({ frame }) => due(frame, known));
  if (!parked) return;
  waiting.delete(parked.frame.p);
  room.bytes.waiting -= parked.bytes;
  const result = admitRequest(env, room, parked.frame, parked.by);
  if (result === "full" || result === "ledger-full") env.port.onFull(parked.by);
  if (result === "dup") wake(env, room, client);
}

function admitRequest(env, room, frame, by) {
  if (unknown(room, frame.c) && frame.b <= room.state.floor && !planted("retired-as-new")) return "retired";
  const known = resolved(room.state, frame.c);
  const body = { c: frame.c, n: frame.n, e: frame.e, action: frame.action, saw: frame.saw };
  if (planted("broadcast-carries-birth")) body.b = frame.b;
  const bytes = frameBytes(frame.action, planted("frame-cost-action-only") ? {} : body);
  if (!planted("no-dedup")) {
    if (frame.n <= known) return "dup";
    if (!due(frame, known)) {
      if (!inRoom(env, room, bytes) && !planted("no-stage-cap")) return "full";
      park(room, frame, by, bytes);
      return "wait";
    }
  }
  if (full(env, room, bytes)) return "full";
  if (ledgerFull(env, room, frame.c, frame.n)) return "ledger-full";
  if (frame.take) {
    body.take = frame.take;
    if (conflicts(room.state.wb, frame.action, frame.saw).length && !planted("late-take-unchecked")) body.keep = true;
  }
  append(env, room, { k: "act", seq: ++room.seq, ...body }, frame);
  wake(env, room, frame.c);
  return "ok";
}

const returns = (room, item) => Boolean(item.origin) && Boolean(item.action) && !item.keep && resolved(room.state, item.c) < item.rn;

const firstCell = (action, saw) => (planted("returned-take-of-a-paste-checks-one-cell") && action.t === "paste" && Array.isArray(saw) ? [{ ...action, cells: action.cells.slice(0, 1) }, saw.slice(0, 1)] : [action, saw]);

function changedSince(room, item) {
  const { wb } = room.state;
  if (planted("returned-delete-not-judged-again") && removesOf(item.action).length > 0) return false;
  if (item.origin[1] !== item.e) return conflicts(wb, ...firstCell(item.action, item.saw)).length > 0;
  return fitsNow(wb, item.action) && stillOpen(wb, item.action, item.saw, item.reviewed ?? null).length > 0;
}

function firstHolder(room, id, by) {
  room.asked ??= new Map();
  if (!room.asked.has(id)) room.asked.set(id, by);
  return room.asked.get(id);
}

function admitAdopt(env, room, frame, by) {
  const entry = covered(room.state, frame.from);
  if (!entry) return "no-lineage";
  for (const item of frame.items) {
    if (item.n <= entry[1]) continue;
    if (item.n !== entry[1] + 1 && !planted("adopt-gap")) return "gap";
    if (item.action && unknown(room, item.c) && room.state.floor > epochOf(frame.from) && !planted("retired-as-new")) {
      env.observer.onAdoptRefused(env, room, frame, item);
      return "retired";
    }
    const back = returns(room, item);
    if (item.origin && item.action) env.observer.onReturnCount(env, item.keep ? "carried" : back ? "open" : "counted");
    const changed = back && !planted("returned-frame-not-judged-again") && changedSince(room, item);
    const restored = changed && item.origin[1] === item.e;
    if (restored && !item.listed && !planted("returned-frame-kept-before-its-mark")) {
      if (planted("returned-frame-waits-for-its-first-holder") && firstHolder(room, item.e, by) !== by) return "gap";
      env.observer.onReturned(env, room, frame, item);
      return { how: "returned", copy: item.origin[0], e: item.e };
    }
    const at = [frame.from, item.n];
    const body = { from: at, org: item.org ?? at, via: [...(item.via ?? []), at].slice(-W), c: item.c, n: item.rn, e: item.e, action: item.action, saw: item.saw };
    if (item.origin) body.origin = item.origin;
    if (item.reviewed) body.reviewed = item.reviewed;
    if (item.keep || changed) body.keep = true;
    if (item.open || restored) body.open = true;
    if (full(env, room, frameBytes(item.action, planted("frame-cost-action-only") ? {} : body))) return "full";
    if (item.action && ledgerFull(env, room, item.c, item.rn)) return "ledger-full";
    if (back) env.observer.onReturnCount(env, "judged");
    if (changed) env.observer.onReturnCount(env, "kept");
    append(env, room, { k: "adopt", seq: ++room.seq, ...body }, frame);
    wake(env, room, item.c);
  }
  return "ok";
}

function admitReceipt(env, room, frame) {
  if (env.hostMade && !planted("host-receipt-trusts-the-tab") && !(room.accepted?.commit === frame.commit && room.accepted.through === frame.through)) return "unseen";
  return takeReceipt(env, room, frame);
}

export function hostReceipt(env, room, frame) {
  env.observer.onFrame(env, room, frame);
  return takeReceipt(env, room, frame);
}

function takeReceipt(env, room, frame) {
  if (frame.through <= room.base.through) return "old";
  if (frame.through > room.seq) return "beyond";
  env.observer.onReceipt(env, room, frame);
  room.base = { commit: frame.commit, etag: frame.etag, through: frame.through };
  append(env, room, { k: "receipt", commit: frame.commit, etag: frame.etag, through: frame.through }, frame);
  while (room.floor < room.log.length) {
    const old = room.log[room.floor];
    const gone = old.k === "receipt" ? old.through < frame.through : old.seq <= frame.through;
    if (!gone) break;
    if (old.k !== "receipt") room.bytes.tail -= old.bytes;
    room.log[room.floor++] = null;
  }
  return "ok";
}

function admitCopy(env, room, frame, by) {
  if (!room.restores.has(frame.job)) room.restores.set(frame.job, newMemory());
  const memory = room.restores.get(frame.job);
  const key = `${frame.job}/${frame.i}/${frame.decide ?? ""}`;
  if (room.answered.has(key) && !planted("restore-judges-a-resent-offer-again")) return room.answered.get(key);
  const file = { record: { gen: room.gen, through: room.seq, epoch: room.epoch }, state: room.state };
  const offer = frame.open && room.settled.has(frame.e) ? { ...frame, open: false } : frame;
  const judged = planted("room-restore-trusts-the-tab") ? frame.judged : weigh(file, offer, memory, frame.i);
  if (counts(judged) && judged.how === "misfit" && !frame.open && !frame.listed && rowMayReturn(file, offer, frame.made) && !planted("misfit-counted-before-it-is-listed")) {
    env.observer.onUnlisted(env, room, frame);
    return { how: "unlisted" };
  }
  if (!counts(judged)) remember(memory, frame, judged, frame.i);
  if (!counts(judged)) {
    env.observer.onCopyJudged(env, room, frame, judged, by);
    if (judged.late && judged.how === "kept") room.settled.add(frame.e);
    const settled = judged.how === "saved" || judged.how === "resolved" || (judged.late && (judged.how === "kept" || judged.how === "misfit"));
    const answer = { how: judged.how, cells: judged.cells, behind: judged.behind, row: judged.row, shown: judged.shown, blocks: judged.blocks, passed: judged.passed, late: judged.late, seq: settled ? room.seq : undefined };
    room.answered.set(key, answer);
    return answer;
  }
  if (judged.how === "kept" && planted("decision-keep-not-counted")) return { how: judged.how, seq: room.seq };
  const [org, ...via] = positions(frame);
  const body = { c: frame.c, n: frame.n, e: frame.e, action: frame.action, saw: frame.saw, org, via: org ? via.slice(-W) : undefined, copy: [frame.copy, frame.i] };
  if (judged.how === "kept") body.keep = true;
  if (frame.decide === "take" && frame.reviewed) body.reviewed = frame.reviewed;
  if (full(env, room, frameBytes(frame.action, body))) return "full";
  if (ledgerFull(env, room, frame.c, frame.n)) return "ledger-full";
  append(env, room, { k: "act", seq: ++room.seq, ...body }, frame, by);
  memory.waiting.delete(frame.i);
  wake(env, room, frame.c);
  const answer = { how: judged.how, seq: room.seq, removed: planted("restored-delete-hides-removed-values") ? undefined : judged.removed };
  if (!planted("wire-offer-judged-again")) room.answered.set(key, answer);
  return answer;
}

function admitWhole(env, room, frame, by) {
  if (frame.k === "copy") return admitCopy(env, room, frame, by);
  if (frame.k === "req") return admitRequest(env, room, frame, by);
  if (frame.k === "adopt") return admitAdopt(env, room, frame, by);
  if (frame.k === "receipt") return admitReceipt(env, room, frame);
  throw new Error(`unknown frame ${frame.k}`);
}

function admitPart(env, room, part, by) {
  if (room.gone?.has(by) && !planted("wire-late-part-staged")) return "closed";
  if (planted("paste-part-admit")) return part.frame ? admitWhole(env, room, assemble([part]), by) : "staged";
  const key = `${by}/${part.key}`;
  let stage = room.staging.get(key);
  if (!stage) {
    const space = next(room, part.order) ? makeRoom(env, room, part.size) : inRoom(env, room, part.size);
    if (!space && !planted("no-stage-cap")) return "full";
    stage = { by, order: part.order, size: part.size, got: 0, parts: new Array(part.m).fill(null) };
    room.staging.set(key, stage);
    room.bytes.staged += stage.size;
  }
  if (stage.parts[part.i]) return "staged";
  stage.parts[part.i] = part;
  if (++stage.got < part.m) return "staged";
  room.staging.delete(key);
  room.bytes.staged -= stage.size;
  const whole = assemble(stage.parts);
  const { action, saw, reviewed } = whole.k === "adopt" ? whole.items[0] : whole;
  if (frameBytes(action, { saw, reviewed }) !== stage.size) return "bad-size";
  const before = room.seq;
  const result = admitWhole(env, room, whole, by);
  if ((result === "full" || result === "ledger-full") && !planted("wire-part-refusal-not-told")) env.port.onFull(by);
  if (typeof result !== "string" && room.seq === before && !planted("restore-frees-space-silently")) env.port.onSpace();
  return result;
}

export function rejoin(room, by) {
  room?.gone?.delete(by);
}

export function dropConnection(room, by) {
  room.gone ??= new Set();
  room.gone.add(by);
  for (const [key, stage] of room.staging) {
    if (stage.by !== by) continue;
    room.staging.delete(key);
    room.bytes.staged -= stage.size;
  }
  for (const waiting of room.wait.values()) {
    for (const [p, entry] of waiting) {
      if (entry.by !== by) continue;
      waiting.delete(p);
      room.bytes.waiting -= entry.bytes;
    }
  }
}

export function admit(env, room, frame, by) {
  if (!room.gen) return "closed";
  env.observer.onFrame(env, room, frame);
  if (frame.gen !== room.gen) {
    const let_in = frame.k === "receipt" ? planted("receipt-any-gen") : planted("no-gen-fence");
    if (!let_in) return "stale";
  }
  return frame.k === "part" ? admitPart(env, room, frame, by) : admitWhole(env, room, frame, by);
}

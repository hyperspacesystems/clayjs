import { planted } from "./planted.mjs";
import { W, nextGeneration, trimLedger } from "./ledger.mjs";
import { newRoom, newInstance, hostReceipt } from "./room.mjs";
import { codec } from "./codec.mjs";
import { serialize, DOC } from "./record.mjs";
import { nextGen, nextCommit, nudgeAll } from "./tab.mjs";

export const sameTables = (a, b) => codec().write(a.state.wb, {}) === codec().write(b.state.wb, {});

export function establishing(env, file) {
  const room = env.port.room();
  const epoch = file.record.epoch + 1;
  const gen = nextGen(env, epoch);
  const commit = nextCommit(env);
  const record = { v: 2, doc: file.record.doc ?? DOC, gen, epoch, commit, parent: file.record.commit, through: 0, room: room.id };
  const [own, before] = file.state.opened ?? [file.record.epoch, file.record.epoch];
  const state = nextGeneration(file.state, file.record.gen, file.record.through, epoch, env.limits.ledgerCap, file.record.room === room.id ? [planted("ledger-turn-restarts-the-room") ? epoch : own, before] : [epoch, own]);
  return { gen, commit, record, state, body: serialize(record, state) };
}

export function openOn(env, record, etag, state) {
  const room = env.port.room();
  if (room.gen) env.observer.onRoomLoss(env, room, "replaced");
  env.port.setRoom(newRoom(record, etag, state, room.id));
  env.observer.onRoom(env, env.port.room());
}

export function fileAccepted(env, file, before) {
  const room = env.port.room();
  if (!room) return "none";
  const { record } = file;
  if (record.room === room.id && record.gen !== room.gen && (!room.gen || record.epoch > room.epoch || planted("host-old-generation-reopens"))) {
    openOn(env, record, file.etag, file.state);
    nudgeAll(env);
    return "establishing";
  }
  if (!room.gen) return "none";
  if (record.gen === room.gen && record.commit === room.base.commit && (sameTables(file, before) || planted("host-same-ignores-tables")) && !planted("host-same-drops-room")) {
    room.base = { ...room.base, etag: file.etag };
    return "same";
  }
  if (record.gen === room.gen && record.room === room.id && record.commit !== room.base.commit && (record.parent === room.base.commit || planted("host-commit-not-next"))) {
    room.accepted = { commit: record.commit, etag: file.etag, through: record.through };
    if (!planted("host-receipt-not-made")) hostReceipt(env, room, { k: "receipt", gen: room.gen, ...room.accepted });
    return "commit";
  }
  env.observer.onRoomLoss(env, room, "ended");
  env.port.setRoom(null);
  return "outside";
}

// The host's own commit of the room's state, on top of the file on disk (rule 17's final save).
export function render(env, file) {
  const room = env.port.room();
  const record = { v: 2, doc: file.record.doc ?? DOC, gen: room.gen, epoch: room.epoch, commit: nextCommit(env), parent: file.record.commit, through: room.seq, room: room.id };
  return { record, body: serialize(record, room.state) };
}

// The one host step for a write that did not come from the room (rule 19). `source` is the file to
// write, already holding the outside change; `current` is the file on disk. `keep` reopens the
// room on the new generation; otherwise the room is dropped and the file names no instance.
export function outsideStep(env, source, current, keep) {
  const live = env.port.room();
  const room = live?.gen ? live : null;
  if (env.hostMade && !planted("host-equal-tables-new-gen") && sameTables(source, current)) return { same: true };
  const cut = room ? [room.gen, room.seq] : [current.record.gen, current.record.through];
  const dirty = Boolean(room) && (room.gen !== current.record.gen || room.seq > current.record.through);
  let backup = null;
  if (dirty && !planted("restore-no-backup")) {
    const record = { v: 2, doc: current.record.doc ?? DOC, gen: room.gen, epoch: room.epoch, commit: nextCommit(env), parent: room.base.commit, through: room.seq, room: room.id };
    backup = { record, body: serialize(record, room.state) };
  }
  const epoch = current.record.epoch + 1;
  const before = planted("restore-replays-admitted") ? {} : (room ?? current).state.seen;
  const merged = [];
  const range = {};
  for (const client of new Set([...Object.keys(source.state.seen), ...Object.keys(before)])) {
    const [low, lowAt] = source.state.seen[client] ?? [0, -1];
    const [high, highAt] = before[client] ?? [0, -1];
    merged.push([client, [Math.max(low, high), Math.max(lowAt, highAt)]]);
    range[client] = [low, high];
  }
  const folded = trimLedger(merged, Math.max(source.state.floor, (room ?? current).state.floor), env.limits.ledgerCap);
  const seen = {};
  const bounds = {};
  for (const [client, [n]] of folded.kept) {
    seen[client] = [n, epoch];
    if (range[client][1] > range[client][0]) bounds[client] = range[client];
  }
  const kept = planted("restore-keeps-lineage");
  const state = {
    wb: source.state.wb,
    seen,
    lineage: kept ? [[current.record.gen, current.record.through], ...current.state.lineage].slice(0, W) : [],
    cut: kept ? null : [...cut, bounds],
    floor: folded.floor,
  };
  if (keep && !live) env.port.setRoom(newInstance(env));
  const instance = keep ? env.port.room() : null;
  const record = { v: 2, doc: current.record.doc ?? DOC, gen: nextGen(env, epoch), epoch, commit: nextCommit(env), parent: current.record.commit, through: 0, room: keep ? instance.id : null, restored: source.record.commit };
  return { same: false, room, dirty, backup, record, state, instance, body: serialize(record, state) };
}

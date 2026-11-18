import { planted } from "./planted.mjs";
import { nextGeneration } from "./ledger.mjs";
import { newRoom, hostReceipt } from "./room.mjs";
import { codec } from "./codec.mjs";
import { serialize, DOC } from "./record.mjs";
import { nextGen, nextCommit, nudgeAll } from "./tab.mjs";

export const sameTables = (a, b) => codec().write(a.state.wb, {}) === codec().write(b.state.wb, {});

export function establishing(env, file) {
  const room = env.port.room();
  const epoch = file.record.epoch + 1;
  const gen = nextGen(env, epoch);
  const commit = nextCommit(env);
  const record = { v: 2, doc: DOC, gen, epoch, commit, parent: file.record.commit, through: 0, room: room.id };
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
  if (record.room === room.id && record.gen !== room.gen) {
    openOn(env, record, file.etag, file.state);
    nudgeAll(env);
    return "establishing";
  }
  if (!room.gen) return "none";
  if (record.gen === room.gen && record.commit === room.base.commit && (sameTables(file, before) || planted("host-same-ignores-tables")) && !planted("host-same-drops-room")) {
    room.base = { ...room.base, etag: file.etag };
    return "same";
  }
  if (record.gen === room.gen && record.room === room.id && record.commit !== room.base.commit) {
    room.accepted = { commit: record.commit, etag: file.etag, through: record.through };
    if (!planted("host-receipt-not-made")) hostReceipt(env, room, { k: "receipt", gen: room.gen, ...room.accepted });
    return "commit";
  }
  env.observer.onRoomLoss(env, room, "ended");
  env.port.setRoom(null);
  return "outside";
}

import { planted } from "./planted.mjs";
import { entryBytes } from "./record.mjs";
import { act } from "./codec.mjs";

export const W = Number(process.env.LAB_W || 16);

export const ledgerMarks = (cap) => ({ cap, rotate: Math.floor(cap * 0.75), trim: Math.floor(cap * 0.5) });

export const newState = (wb) => ({ wb, seen: {}, lineage: [], cut: null, floor: -1 });

export const epochOf = (gen) => Number(gen.split(".")[0]);

export const resolved = (state, client) => state.seen[client]?.[0] ?? 0;

export const covered = (state, gen) => state.lineage.find(([g]) => g === gen) ?? null;

export function applyFrame(state, frame, epoch) {
  if (frame.k === "adopt") {
    const entry = covered(state, frame.from[0]);
    if (entry && frame.from[1] > entry[1]) entry[1] = frame.from[1];
    if (!frame.action) return { applied: false, dup: true };
  }
  if (!planted("no-dedup") && resolved(state, frame.c) >= frame.n) return { applied: false, dup: true };
  const applied = !frame.keep && act(state.wb, frame.action);
  const n = Math.max(frame.n, resolved(state, frame.c));
  delete state.seen[frame.c];
  state.seen[frame.c] = [n, epoch];
  return { applied, dup: false };
}

export function trimLedger(entries, floor, cap) {
  const marks = ledgerMarks(cap);
  const byAge = entries.slice().sort((a, b) => a[1][1] - b[1][1]);
  let bytes = byAge.reduce((sum, [client, value]) => sum + entryBytes(client, value), 2);
  let gone = 0;
  if (bytes > marks.rotate && !planted("no-ledger-trim")) {
    for (; gone < byAge.length && bytes > marks.trim; gone++) {
      bytes -= entryBytes(...byAge[gone]);
      floor = Math.max(floor, byAge[gone][1][1]);
    }
  }
  return { kept: byAge.slice(gone), floor };
}

export function nextGeneration(state, gen, through, epoch, cap, opened) {
  const live = Object.entries(state.seen).filter(([, [, at]]) => at >= epoch - W);
  const { kept, floor } = trimLedger(live, state.floor, cap);
  const lineage = [[gen, through], ...state.lineage].slice(0, W);
  return { wb: state.wb, seen: Object.fromEntries(kept), lineage, cut: lineage.length < W ? state.cut : null, floor, ...(opened === undefined ? {} : { opened }) };
}

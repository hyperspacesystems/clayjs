import { codec } from "./codec.mjs";
import { utf8Bytes } from "./lib.mjs";

const KIB = 1024;
const MIB = KIB * KIB;

export const REAL_LIMITS = Object.freeze({
  opsPerFrame: 128,
  storeBytes: 4 * MIB,
  roomBytes: 6 * MIB,
  actionBytes: 3 * MIB,
  ledgerCap: 2 * KIB,
});

// Bytes an ordered room charges against the process's live-room total per byte it counts. That
// total (LIVE_LIMITS.liveBytes) already allows 2 to 4.5 bytes of heap per counted byte. Step P4
// measured with the small codec (tests/live-room/measure-rooms.mjs, 2026-11-18): an open room holds
// 2.2 to 3.7 bytes of heap per file byte (wide sheets to one-column lists), so a document is charged
// its size; unsaved edits hold up to 8.6 bytes of heap per counted byte (a paste into empty cells),
// so they are charged twice. Rerun with the sheet codec and compare its ratios with 4.5.
export const ROOM_HEAP = Object.freeze({ doc: 1, tail: 2 });

const env = (name, fallback) => Number(process.env[name] || fallback);

export function labLimits(over = {}) {
  const limits = {
    opsPerFrame: env("LAB_OPS_PER_FRAME", REAL_LIMITS.opsPerFrame / 64),
    storeBytes: env("LAB_STORE_BYTES", REAL_LIMITS.storeBytes / KIB),
    roomBytes: env("LAB_ROOM_BYTES", REAL_LIMITS.roomBytes / KIB),
    actionBytes: env("LAB_ACTION_BYTES", KIB),
    ledgerCap: env("LAB_LEDGER_CAP", 480),
  };
  for (const [key, value] of Object.entries(over)) if (value !== undefined) limits[key] = value;
  return limits;
}

export const FRAME_OVERHEAD = 64;

export const actionBytes = (action) => (action == null ? 4 : codec().size(action));

const ACTION_ONLY = process.env.LAB_FRAME_COST === "action";

const bytesOf = (value) => (value === undefined || value === null ? 0 : utf8Bytes(JSON.stringify(value)));

export const frameBytes = (action, { saw, b, org, via, reviewed } = {}) => actionBytes(action) + FRAME_OVERHEAD + (ACTION_ONLY ? 0 : bytesOf(saw) + bytesOf(b) + bytesOf(org) + bytesOf(via) + bytesOf(reviewed));

export const opsOf = (action) => (action ? codec().ops(action) : 1);

export const frameOps = (frame) => {
  if (frame.k === "part") return codec().partOps(frame);
  if (frame.k === "req" || frame.k === "copy") return opsOf(frame.action);
  if (frame.k === "adopt") return frame.items.reduce((sum, item) => sum + opsOf(item.action), 0);
  return 1;
};

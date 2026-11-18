const KIB = 1024;
const MIB = KIB * KIB;

export const REAL_LIMITS = Object.freeze({
  opsPerFrame: 128,
  storeBytes: 4 * MIB,
  roomBytes: 6 * MIB,
  actionBytes: 3 * MIB,
  ledgerCap: 2 * KIB,
});

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

export const actionBytes = (action) => Buffer.byteLength(JSON.stringify(action ?? null), "utf8");

const ACTION_ONLY = process.env.LAB_FRAME_COST === "action";

const bytesOf = (value) => (value === undefined || value === null ? 0 : Buffer.byteLength(JSON.stringify(value), "utf8"));

export const frameBytes = (action, { saw, b, org, via, reviewed } = {}) => actionBytes(action) + FRAME_OVERHEAD + (ACTION_ONLY ? 0 : bytesOf(saw) + bytesOf(b) + bytesOf(org) + bytesOf(via) + bytesOf(reviewed));

export const cellsOf = (action) => (action?.t === "paste" ? action.cells : action?.t === "set" ? [[action.row, action.col, action.value]] : []);

export const opsOf = (action) => (action?.t === "paste" ? Math.max(1, action.cells.length) : 1);

export const frameOps = (frame) => {
  if (frame.k === "part") return frame.cells.length;
  if (frame.k === "req" || frame.k === "copy") return opsOf(frame.action);
  if (frame.k === "adopt") return frame.items.reduce((sum, item) => sum + opsOf(item.action), 0);
  return 1;
};

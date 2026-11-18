// Copied from hyper/clayjs/src/page/model.js lines 22-57, so the lab does not pull
// in the ProseMirror bundle that file imports. Keep it in step with that source.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const VALID_KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

export const isKey = (key) => typeof key === "string" && VALID_KEY.test(key);

// A key strictly between a and b, read as base-62 fractions 0.a and 0.b; a ""
// is zero and b null is one. No key ends in "0", so there is always room
// between two of them.
function midpoint(a, b) {
  if (b !== null) {
    let n = 0;
    while ((a[n] || "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

export function keyBetween(a = null, b = null) {
  if (a !== null && !isKey(a)) throw new TypeError(`page: invalid order key ${a}`);
  if (b !== null && !isKey(b)) throw new TypeError(`page: invalid order key ${b}`);
  if (a !== null && b !== null && a >= b) throw new RangeError(`page: order key ${a} is not before ${b}`);
  return midpoint(a ?? "", b);
}

// n keys between a and b, spread by halving so a thousand-row import keeps
// short keys.
export function keysBetween(a, b, n) {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  const mid = keyBetween(a, b);
  const half = Math.floor(n / 2);
  return [...keysBetween(a, mid, half), mid, ...keysBetween(mid, b, n - half - 1)];
}

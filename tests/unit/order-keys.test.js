/**
 * @jest-environment node
 */
import { createHash } from "node:crypto";
import * as esbuild from "esbuild";
import * as shared from "../../src/lib/order-keys.js";
import * as pageModel from "../../src/page/model.js";

/**
 * The fractional order keys live in src/lib/order-keys.js, which brings no ProseMirror,
 * page module or vendored library with it, and src/page/model.js hands the same three
 * functions to the page. The sapjs grid codec carries its own copy of them, so both are
 * held to one set of vectors: the literals below are the `keys` member of
 * sapjs/test/grid-codec/golden/host-vectors.json (written by
 * sapjs/test/grid-codec/support/key-vectors.js, sapjs commit 8973292). The 1,000 key
 * spread is kept as its SHA-256 instead of a thousand literals.
 */

const { isKey, keyBetween, keysBetween } = shared;
const ROOT = new URL("../../", import.meta.url).pathname;
const SHARED = "src/lib/order-keys.js";

const BETWEEN = [
  [null, null, "V"], ["G", null, "d"], [null, "G", "8"], ["G", "V", "O"], ["V", "W", "VV"], ["Vz", "W", "VzV"],
  ["z", null, "zV"], ["zz", null, "zzV"], ["1", "2", "1V"], ["01", "1", "0W"], ["a", "a1", "a0V"],
];
const VALID = [
  ["a0", false], ["", false], ["0", false], ["00", false], ["1", true], ["a", true], ["zz", true], ["Vz", true],
  ["01", true], ["a-", false], ["A B", false], ["é", false], ["a\n", false], ["Z9", true], ["0a", true],
];
const THROWS = [
  ["G", "G", "RangeError"], ["V", "G", "RangeError"], ["a0", null, "TypeError"], [null, "a0", "TypeError"],
  ["a0", "b", "TypeError"], ["", null, "TypeError"],
];
const SPREAD = [
  [null, null, 6, ["8", "G", "O", "V", "d", "l"]],
  ["G", "V", 5, ["I", "K", "O", "Q", "S"]],
  [null, null, 60, [..."123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijlmnopqrstuvwxyz"]],
  [null, null, 5, ["8", "G", "V", "d", "l"]],
];
const THOUSAND_SHA256 = "d8b7832a13229fd8856c99f32b38eebe481ce2e90304c04a13b2f7df80ddbe5d";

const thrownBy = (a, b) => {
  try {
    keyBetween(a, b);
    return null;
  } catch (error) {
    return error.name;
  }
};

async function graphOf(entry) {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    write: false,
    metafile: true,
    external: ["https://*"],
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs);
}

// What a boot without ProseMirror cannot carry: the ProseMirror bundle under any name,
// any page module and any vendored library.
const heavy = (inputs) => inputs.filter((file) => /prosemirror/i.test(file) || file.startsWith("src/page/") || file.startsWith("src/vendor/"));

test("the page model exports the shared key functions themselves", () => {
  expect(Object.keys(shared).sort()).toEqual(["isKey", "keyBetween", "keysBetween"]);
  for (const name of Object.keys(shared)) expect([name, pageModel[name] === shared[name]]).toEqual([name, true]);
});

test("isKey and keyBetween match the vectors the sapjs grid codec is held to", () => {
  for (const [key, ok] of VALID) expect([key, isKey(key)]).toEqual([key, ok]);
  for (const [a, b, key] of BETWEEN) expect([a, b, keyBetween(a, b)]).toEqual([a, b, key]);
  for (const [a, b, name] of THROWS) expect([a, b, thrownBy(a, b)]).toEqual([a, b, name]);
});

test("keysBetween spreads match the vectors the sapjs grid codec is held to", () => {
  for (const [a, b, n, keys] of SPREAD) expect([a, b, n, keysBetween(a, b, n)]).toEqual([a, b, n, keys]);

  const thousand = keysBetween(null, null, 1000);
  expect(thousand).toHaveLength(1000);
  expect(thousand.every(isKey)).toBe(true);
  expect(thousand.every((key, i) => i === 0 || thousand[i - 1] < key)).toBe(true);
  expect(Math.max(...thousand.map((key) => key.length))).toBeLessThanOrEqual(2);
  expect([...thousand.slice(0, 5), ...thousand.slice(-3)]).toEqual(["04", "08", "0C", "0G", "0K", "zt", "zv", "zx"]);
  expect(createHash("sha256").update(JSON.stringify(thousand)).digest("hex")).toBe(THOUSAND_SHA256);
});

test("the shared module's graph has no ProseMirror, page module or vendored library, and the page model's graph has all three", async () => {
  const inputs = await graphOf(SHARED);
  expect(inputs.length).toBeGreaterThan(0);
  expect(inputs).toContain(SHARED);
  expect(heavy(inputs)).toEqual([]);

  const page = await graphOf("src/page/model.js");
  expect(page).toContain(SHARED);
  expect(heavy(page)).toEqual(expect.arrayContaining(["src/page/model.js", "src/vendor/prosemirror.vendor.js"]));
});

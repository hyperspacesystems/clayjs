import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { prepareHybridConversion, migrateHybridValues, YMigrationError, blocksFromYValue } from "../../../../src/page/ybind/core.js";
import { RECORD } from "../fixtures/all-kinds.js";

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const originalEncoder = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  Object.defineProperty(globalThis, "TextEncoder", { value: TextEncoder, configurable: true });
});
afterAll(() => {
  if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
  else delete globalThis.crypto;
  if (originalEncoder) Object.defineProperty(globalThis, "TextEncoder", originalEncoder);
  else delete globalThis.TextEncoder;
});

const source = (text = "AAAA") => ({ blocks: { p: { t: "paragraph", pos: "A", c: text } } });
const golden = "31c0ff759ab43beb1b5cc06df456d3ac2d422c2200acb52b16e3e5bffae5f0ec";
const reverseKeys = (value) => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])])) : value;

test("pairs the exact SHA-256 baseline with the existing deterministic conversion", async () => {
  const input = source();
  const result = await prepareHybridConversion([["blockeditor", input]]);
  expect(result.baseline).toBe(golden);
  expect(result.value).toEqual(migrateHybridValues([input]));
  expect(blocksFromYValue(result.value).p.c).toBe("AAAA");
  expect(input).toEqual(source());
});

test("keeps DOM tag order and the converter's multi-tag precedence", async () => {
  const tags = [["blockeditor.2", source("first")], ["blockeditor.1", source("second")]];
  const forward = await prepareHybridConversion(tags);
  const reverse = await prepareHybridConversion([...tags].reverse());
  expect(blocksFromYValue(forward.value).p.c).toBe("second");
  expect(blocksFromYValue(reverse.value).p.c).toBe("first");
  expect(forward.baseline).not.toBe(reverse.baseline);
});

test("includes names, tombstones and raw hidden records in baseline identity", async () => {
  const plain = await prepareHybridConversion([["blockeditor", source()]]);
  const renamed = await prepareHybridConversion([["blockeditor.1", source()]]);
  const deleted = await prepareHybridConversion([["blockeditor", { ...source(), deleted: { absent: true } }]]);
  const hidden = await prepareHybridConversion([["blockeditor", { blocks: { ...source().blocks, gone: { t: "paragraph", pos: "B", c: "hidden" } }, deleted: { gone: true } }]]);
  expect(new Set([plain.baseline, renamed.baseline, deleted.baseline, hidden.baseline]).size).toBe(4);
  expect(renamed.value).toEqual(plain.value);
  expect(deleted.value).toEqual(plain.value);
  expect(hidden.value).toEqual(plain.value);
});

test("canonicalizes nested object keys without losing the complete source data", async () => {
  const record = JSON.parse(JSON.stringify(RECORD));
  const first = await prepareHybridConversion([["blockeditor", record]]);
  const second = await prepareHybridConversion([["blockeditor", reverseKeys(record)]]);
  expect(second).toEqual(first);
  expect(first.value).toEqual(migrateHybridValues([RECORD]));
});

test("owns its source before asynchronous hashing and leaves the caller free to edit", async () => {
  const tags = [["blockeditor", source()]];
  const pending = prepareHybridConversion(tags);
  tags[0][0] = "blockeditor.9";
  tags[0][1].blocks.p.c = "BBBB";
  tags.push(["blockeditor", source("later")]);
  const result = await pending;
  expect(result.baseline).toBe(golden);
  expect(blocksFromYValue(result.value).p.c).toBe("AAAA");
  expect(tags[0][1].blocks.p.c).toBe("BBBB");
});

test.each([
  ["no tags", []],
  ["not a list", {}],
  ["unnamed value", [source()]],
  ["extra tuple field", [["blockeditor", source(), "extra"]]],
  ["duplicate name", [["blockeditor", source()], ["blockeditor", source()]]],
  ["unrelated store", [["counter", source()]]],
  ["non-numeric suffix", [["blockeditor.other", source()]]],
  ["empty block type", [["blockeditor", { blocks: { p: { t: "", pos: "A" } } }]]],
  ["non-JSON value", [["blockeditor", { blocks: { p: { t: "paragraph", pos: "A", c: undefined } } }]]],
  ["non-finite number", [["blockeditor", { blocks: { p: { t: "paragraph", pos: "A", c: Infinity } } }]]],
])("refuses %s without returning a conversion", async (label, tags) => {
  await expect(prepareHybridConversion(tags)).rejects.toBeInstanceOf(YMigrationError);
});

test("refuses an already converted page and cyclic input", async () => {
  await expect(prepareHybridConversion([["blockeditor", migrateHybridValues([source()])]])).rejects.toBeInstanceOf(YMigrationError);
  const cyclic = source();
  cyclic.self = cyclic;
  await expect(prepareHybridConversion([["blockeditor", cyclic]])).rejects.toBeInstanceOf(YMigrationError);
});

test("the public helper executes in a real Node process without DOM globals", () => {
  const module = new URL("../../../../src/page/ybind/core.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    assert.equal(typeof window, "undefined");
    assert.equal(typeof document, "undefined");
    const { prepareHybridConversion, blocksFromYValue } = await import(${JSON.stringify(module)});
    const result = await prepareHybridConversion(${JSON.stringify([["blockeditor", source()]])});
    assert.equal(blocksFromYValue(result.value).p.c, "AAAA");
    process.stdout.write(result.baseline);
  `;
  expect(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).toBe(golden);
});

/**
 * @jest-environment node
 */
// The protocol core trusts a codec only as far as the codec laws hold, so checkCodec must
// accept the lab's small workbook codec and reject a codec that breaks any one law.
import seedWindowHelpers from "../../helpers/seed-window.cjs";
import { checkCodec } from "../../../src/live-room/codec.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";
import { sample } from "../../live-room/lab/codec-tiny/sample.mjs";
import { codec as list } from "../../live-room/lab/codec-list/reducer.mjs";
import { sample as listSample } from "../../live-room/lab/codec-list/sample.mjs";
import { usePlant } from "../../live-room/lab/core/planted.mjs";

const window = seedWindowHelpers.seedWindow({ name: "live-room codec laws", full: 50, routine: 5 });

const lawsOf = (codec) => [...new Set(checkCodec(codec, sample, { runs: 150 }).map((failure) => failure.law))];

afterEach(() => usePlant(""));

// Bug it catches: a change to the small workbook codec breaks a law the lab's proof assumes,
// such as a delete whose inverse loses a cell.
test("the small workbook codec keeps every law", () => {
  for (const seed of window.seeds) expect({ seed, window: window.label, failures: checkCodec(tiny, sample, { seed, runs: 100 }) }).toEqual({ seed, window: window.label, failures: [] });
});

// Bug it catches: the list codec (step P2b's second codec, which runs the lab's proof without
// the workbook's names) breaks a law, so a sweep that passes with it would prove nothing.
test("the list codec keeps every law", () => {
  for (const seed of window.seeds) expect({ seed, window: window.label, failures: checkCodec(list, listSample, { seed, runs: 100 }) }).toEqual({ seed, window: window.label, failures: [] });
});

let calls = 0;
const touched = new WeakSet();
const broken = {
  shape: { ...tiny, holds: undefined },
  C1: { ...tiny, apply: (doc, action) => (++calls % 2 ? tiny.apply(doc, action) : { out: "refused", inverse: null }) },
  C2: { ...tiny, read: (bytes) => ({ ...tiny.read(bytes), record: {} }) },
  C3: {
    ...tiny,
    apply(doc, action) {
      if (touched.has(doc)) return { out: "refused", inverse: null };
      touched.add(doc);
      return tiny.apply(doc, action);
    },
  },
  C4: {
    ...tiny,
    apply(doc, action) {
      const result = tiny.apply(doc, action);
      if (result.out === "refused") doc.rows.stray = { pos: "0", cells: { c1: "x" } };
      return result;
    },
  },
  C5: { ...tiny, seen: (doc, action) => (action.t === "set" ? ["not what was shown"] : tiny.seen(doc, action)) },
  C6: {
    ...tiny,
    split(unit, limits) {
      const { head, parts } = tiny.split(unit, limits);
      return { head, parts: parts.slice(0, -1) };
    },
  },
  C7: { ...tiny, fits: () => true },
  C8: { ...tiny, creates: (action) => (action.t === "ins" ? [`${action.row}-copy`] : []) },
  C9: { ...tiny, size: () => 1 },
  C10: { ...tiny, apply: (doc, action) => ({ ...tiny.apply(doc, action), inverse: { t: "paste", cells: [] } }) },
  C11: { ...tiny, conflicts: () => [] },
  C12: { ...tiny, review: (action, saw) => saw },
  C13: { ...tiny, preview: (doc) => structuredClone(doc) },
  C14: { ...tiny, holds: () => true },
  C17: { ...tiny, removes: () => [] },
  ids: { ...tiny, targets: (action) => tiny.targets(action).map((target) => target.split("/")) },
  ops: { ...tiny, ops: () => 1 },
};

const partsWith = (change) => ({
  ...tiny,
  split(unit, limits) {
    const { head, parts } = tiny.split(unit, limits);
    return { head, parts: parts.map((part) => change(part, unit)) };
  },
});

// Bug it catches: a codec's split breaks a big edit in a way C6 must see: a part that
// overwrites a field of the core's part frame, a reviewed saw copied whole into every part,
// or parts whose operations do not add up.
test.each([
  ["a part with its own order field", partsWith((part) => ({ ...part, order: [] }))],
  ["the reviewed saw copied into every part", partsWith((part, unit) => ({ ...part, reviewed: unit.reviewed }))],
  ["parts that count no operations", { ...tiny, partOps: () => 0 }],
  ["a head that drops the reviewed saw", { ...tiny, split: (unit, limits) => ({ ...tiny.split(unit, limits), head: { ...tiny.split(unit, limits).head, reviewed: null } }) }],
])("a codec with %s is rejected with C6", (_, codec) => {
  expect(lawsOf(codec)).toContain("C6");
});

// Bug it catches: a member that throws on a saw the core passes (null for a blind check, or a
// stale one) passes the laws and then ends the room when a late edit is judged.
test("a codec whose conflicts throws without a saw is rejected", () => {
  const strict = { ...tiny, conflicts: (doc, action, saw) => (saw === null && action.t === "set" ? JSON.parse("") : tiny.conflicts(doc, action, saw)) };
  expect(lawsOf(strict)).toContain("throws");
});

// Bug it catches: C2 compares only bytes written twice, so a writer that drops a field on
// every save passes.
test("a codec whose writer drops a column is rejected with C2", () => {
  const dropC2 = (doc) => ({ rows: Object.fromEntries(Object.entries(doc.rows).map(([id, row]) => [id, { ...row, cells: Object.fromEntries(Object.entries(row.cells).filter(([col]) => col !== "c2")) }])) });
  expect(lawsOf({ ...tiny, write: (doc, record) => tiny.write(dropC2(doc), record) })).toContain("C2");
});

// Bug it catches: checkCodec stops testing a law, so a codec that breaks it is registered and
// the room trusts it.
test.each(Object.keys(broken))("a codec that breaks %s is rejected", (law) => {
  calls = 0;
  expect(lawsOf(broken[law])).toContain(law);
});

// Bug it catches: a planted defect inside the codec itself (a set that wipes its whole row)
// passes the laws.
test("the small workbook codec with a planted row wipe is rejected", () => {
  usePlant("row-granularity");
  expect(lawsOf(tiny)).toContain("C10");
});

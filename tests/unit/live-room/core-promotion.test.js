/**
 * @jest-environment node
 */
// The live room's protocol is the frozen lab's core, generated into src/live-room/core
// with every planted defect removed, and the lab's own oracle judges it.
import fs from "node:fs";
import path from "node:path";
import seedWindowHelpers from "../../helpers/seed-window.cjs";
import { buildCore, strays, OUT } from "../../../scripts/build-live-room-core.mjs";
import { conform } from "../../../scripts/live-room-conformance.mjs";

const window = seedWindowHelpers.seedWindow({ name: "live-room core promotion fuzz", full: 600, routine: 30 });
if (!window.seeds.length) throw new Error(`${window.label} picks no seed`);
const from = Math.min(...window.seeds);
const seeds = Math.max(...window.seeds) - from + 1;

// Bug it catches: someone edits src/live-room/core by hand, leaves a file there the lab
// does not have, or a planted branch or a Node-only global survives the generator, so the
// product runs code the lab never judged.
test("src/live-room/core is the lab core with every planted defect removed", () => {
  const files = buildCore();
  expect(Object.keys(files)).toEqual(expect.arrayContaining(["room.js", "tab.js", "ledger.js", "recover.js"]));
  expect(strays(files)).toEqual([]);
  for (const [name, text] of Object.entries(files)) {
    expect(fs.readFileSync(path.join(OUT, name), "utf8")).toBe(text);
    expect(text).not.toMatch(/\bplanted\b|\bprocess\b/);
    expect(text).not.toMatch(/from "(?!\.\/[\w-]+\.js")/);
  }
});

// Bug it catches: the generator folds a branch the wrong way, and a scenario or a
// recorded regression that the lab passes fails on the product core.
test("the product core passes every lab scenario and recorded regression", () => {
  const report = conform({ adapter: "product", suite: "vectors" });
  expect(report.parts[0].runs).toBeGreaterThan(400);
  expect(report.parts[0].first).toEqual([]);
}, 180000);

// Bug it catches: a runner that cannot fail, such as one whose drivers read the lab core
// instead of the product. Each of the lab core's planted defects, switched on in a
// product core, must fail the scenarios that list it.
test("every planted defect of the lab core fails through the product adapter", () => {
  const report = conform({ adapter: "product", suite: "plants" });
  expect(report.parts[0].runs).toBeGreaterThan(150);
  expect(report.parts[0].first).toEqual([]);
}, 180000);

// Bug it catches: the product core behaves differently from the lab core on the same
// sessions (an esbuild fold that changes a count), which the oracle alone might pass.
test("the product core gives the lab's own counts on the same sessions", () => {
  for (const profile of ["v3", "v8", "v9"]) {
    const lab = conform({ adapter: "lab", suite: "fuzz", from, seeds, profile, modes: ["scrambled"] });
    const product = conform({ adapter: "product", suite: "fuzz", from, seeds, profile, modes: ["scrambled"] });
    expect({ profile, seeds: window.label, failures: product.failures, totals: product.parts[0].totals }).toEqual({ profile, seeds: window.label, failures: 0, totals: lab.parts[0].totals });
  }
}, 180000);

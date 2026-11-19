/**
 * @jest-environment node
 */
// C3's gate: the product core passes the lab's whole session sweep, not only the scrambled
// room sessions that core-promotion.test.js compares with the lab. sapjs's room codec (S5)
// starts when this file is on origin.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import seedWindowHelpers from "../../helpers/seed-window.cjs";
import { buildCore } from "../../../scripts/build-live-room-core.mjs";
import { conform } from "../../../scripts/live-room-conformance.mjs";

const window = seedWindowHelpers.seedWindow({ name: "live-room conformance core", full: 400, routine: 20 });
if (!window.seeds.length) throw new Error(`${window.label} picks no seed`);
const from = Math.min(...window.seeds);
const seeds = Math.max(...window.seeds) - from + 1;
const PROFILES = ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10"];

const failed = (report) => report.parts.filter((part) => part.failures).map((part) => ({ part: part.part, failures: part.failures, first: part.first }));

const outcome = (report) => report.parts.map((part) => ({ part: part.part, failures: part.failures, totals: part.totals }));

// Bug it catches: a core change that only shows when frames arrive in order, in a profile the
// promotion test does not run, or in file-only mode (no room), such as a ledger rule the
// generator folds differently for file saves. The oracle may pass such a change, so the
// product must also give the lab's own counts on the same sessions.
test("the product core matches the lab in ordered room sessions in every profile and in file-only sessions in both formats", () => {
  for (const profile of PROFILES) {
    const product = conform({ adapter: "product", suite: "fuzz", from, seeds, profile, modes: ["ordered"] });
    expect({ profile, seeds: window.label, failed: failed(product) }).toEqual({ profile, seeds: window.label, failed: [] });
    const lab = conform({ adapter: "lab", suite: "fuzz", from, seeds, profile, modes: ["ordered"] });
    expect({ profile, seeds: window.label, outcome: outcome(product) }).toEqual({ profile, seeds: window.label, outcome: outcome(lab) });
  }
  const files = conform({ adapter: "product", suite: "files", from, seeds, fileSeeds: seeds });
  expect(files.parts.length).toBeGreaterThanOrEqual(2);
  expect({ seeds: window.label, failed: failed(files) }).toEqual({ seeds: window.label, failed: [] });
  const lab = conform({ adapter: "lab", suite: "files", from, seeds, fileSeeds: seeds });
  expect({ seeds: window.label, outcome: outcome(files) }).toEqual({ seeds: window.label, outcome: outcome(lab) });
}, 300000);

// Bug it catches: a product core that reads the document itself instead of through the codec
// (a workbook field or action kind), which every small-codec sweep passes. The lab's list codec
// has the small codec's meaning under other names and shapes (step P2b), and the product core
// must pass ordered room sessions and file-only sessions with it.
test("the product core passes with the list codec", () => {
  const rooms = conform({ adapter: "product", suite: "fuzz", codec: "list", from, seeds, profile: "v10", modes: ["ordered", "scrambled"] });
  const files = conform({ adapter: "product", suite: "files", codec: "list", from, seeds, fileSeeds: seeds });
  expect({ seeds: window.label, failed: [...failed(rooms), ...failed(files)] }).toEqual({ seeds: window.label, failed: [] });
}, 300000);

// Bug it catches: a sweep that cannot fail on the product, such as drivers that read the lab
// core or an oracle that never runs in that mode. A product core built with one known defect
// switched on must fail the sweep: the host never makes the receipt (ordered room sessions),
// and a file save does not rebase on the file it lands on (file-only sessions).
test.each([
  ["host-receipt-not-made", { suite: "fuzz", profile: "v10", modes: ["ordered"] }],
  ["file-save-no-rebase", { suite: "files" }],
])("a product core with %s switched on fails its sweep", (plant, sweep) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-room-forced-"));
  try {
    for (const [name, text] of Object.entries(buildCore({ force: [plant] }))) fs.writeFileSync(path.join(dir, name), text);
    const report = conform({ adapter: "product", core: dir, from, seeds: Math.max(seeds, 20), fileSeeds: Math.max(seeds, 20), ...sweep });
    expect(report.failures).toBeGreaterThan(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 300000);

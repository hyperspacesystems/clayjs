import { runPreset } from "./harness/fuzz.js";
import { GROUPS, ALLOWED } from "./harness/presets.js";
import seedWindowHelpers from "../../../helpers/seed-window.cjs";

const { seeds, label } = seedWindowHelpers.seedWindow({ name: "ybind fuzz-smoke", full: 20, routine: 4 });

test.each(GROUPS.m1)("preset %s, no findings", async (preset) => {
  const lines = [];
  for (const seed of seeds) {
    const out = await runPreset({ preset, seeds: 1, from: seed });
    const bad = Object.keys(out.summary).filter((c) => !(ALLOWED[preset] ?? []).includes(c));
    if (bad.length) lines.push(...out.lines.map((line) => `${line} (rerun: TEST_SEEDS=${seed})`));
  }
  if (lines.length) throw new Error(`${label}\n${lines.join("\n")}`);
}, 120000);

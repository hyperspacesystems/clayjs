/**
 * @jest-environment node
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import seedWindowHelpers from "../helpers/seed-window.cjs";
import shardHelpers from "../helpers/shard.cjs";
import DurationSequencer from "../duration-sequencer.cjs";

const { seedWindow, depthOf } = seedWindowHelpers;
const { shardItems } = shardHelpers;

describe("seed depth", () => {
  test("a box or CI runs the full set, a local run the daily window, and an unknown depth refuses", () => {
    expect(depthOf({ TESTBOX: "1" })).toBe("full");
    expect(depthOf({ CI: "true" })).toBe("full");
    expect(depthOf({})).toBe("routine");
    expect(depthOf({ TESTBOX: "1", TEST_DEPTH: "routine" })).toBe("routine");
    expect(() => depthOf({ TESTBOX: "1", TEST_DEPTH: "ful" })).toThrow("TEST_DEPTH must be full or routine");
  });

  test("one cycle of daily windows runs every seed of the full set exactly once", () => {
    for (const [full, routine] of [[60, 6], [15, 6], [20, 3]]) {
      const cycle = Math.ceil(full / routine);
      const seen = [];
      for (let day = 0; day < cycle; day += 1) {
        const { seeds, depth } = seedWindow({ name: "h", full, routine, env: {}, now: Date.UTC(2026, 10, 17) + day * 86400000 });
        expect(depth).toBe("routine");
        seen.push(...seeds);
      }
      expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: full }, (_, i) => i + 1));
    }
  });

  test("pinned seeds win, and a box run records the depth it ran", () => {
    expect(seedWindow({ name: "h", full: 60, routine: 6, env: { TESTBOX: "1", TEST_SEEDS: "3-5,9" } }).seeds).toEqual([3, 4, 5, 9]);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "seed-window-"));
    try {
      seedWindow({ name: "race harness", full: 60, routine: 6, env: { TESTBOX: "1", TESTBOX_OUT: out } });
      seedWindow({ name: "race harness", full: 60, routine: 6, env: { TEST_SEED_DAY: "2026-11-17", TESTBOX_OUT: out } });
      const lines = fs.readFileSync(path.join(out, "seed-windows.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toEqual([
        { name: "race harness", depth: "full", count: 60 },
        { name: "race harness", depth: "routine", count: 6, day: "2026-11-17" },
      ]);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("shards", () => {
  test("the shard files on disk deal every item to exactly one shard, weighted or not, and a gap refuses", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shards-"));
    try {
      const files = [1, 2, 3, 4, 5, 6].map((n) => path.join(dir, `race-${n}.test.js`));
      for (const file of files) fs.writeFileSync(file, "");
      const items = Array.from({ length: 57 }, (_, i) => i);
      for (const weight of [() => 1, (item) => (item < 2 ? 27 : 2)]) {
        const dealt = files.flatMap((file) => shardItems(file, items, weight));
        expect(dealt.sort((a, b) => a - b)).toEqual(items);
      }
      fs.rmSync(files[2]);
      expect(() => shardItems(files[0], items)).toThrow("numbered 1 to N with none missing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("duration order", () => {
  test("unlisted files start first, then listed files slowest first, whatever the path separator", () => {
    const sequencer = new DurationSequencer();
    sequencer.durations = {
      "tests/unit/slow-small.test.js": 40,
      "tests/unit/windows-path.test.js": 20,
      "tests/unit/fast-large.test.js": 1,
    };
    const sizes = {
      "/repo/tests/unit/fast-large.test.js": 90000,
      "/repo/tests/unit/slow-small.test.js": 100,
      "/repo/tests\\unit\\windows-path.test.js": 50,
      "/repo/tests/unit/unlisted.test.js": 10,
    };
    const context = { config: { rootDir: "/repo", cache: false }, hasteFS: { getSize: (file) => sizes[file] } };
    const tests = Object.keys(sizes).map((file) => ({ path: file, context }));
    expect(sequencer.sort(tests).map((test) => path.basename(test.path.replaceAll("\\", "/")))).toEqual([
      "unlisted.test.js",
      "slow-small.test.js",
      "windows-path.test.js",
      "fast-large.test.js",
    ]);
  });
});

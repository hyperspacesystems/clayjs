import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import shard from "../../helpers/shard.cjs";
import { MUTATIONS } from "../../mode-counterexamples/mutations.mjs";

/**
 * The corpus selftest, split by defect: each mode-case-selftest-<n>.test.js file runs one
 * `selftest --only` over the defects dealt to it, so a run still plants all six, in
 * separate workers. Each defect's own line must say whether the corpus feels it.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = path.join(ROOT, "scripts/mode-counterexamples.mjs");
const CASES = path.join(ROOT, "tests/mode-counterexamples/cases");
// The cases a selftest of the whole corpus takes six minutes to reach. These five carry
// four of the defects the corpus can feel — a write the exit never made, a view announced
// before the save was accepted, a listener a cycle keeps and a flush that wrote inside a
// later generation's exit — so one minute proves the planting and the verdict for those.
// The two only the rest of the corpus feels are named below.
const SUBSET = ["canonical-freeze", "cycles-no-growth", "cycles-one-write", "enter-leave-one-write", "stale-flush-generation"];
const UNFELT = ["rebaseline-current-dom", "route-draft-to-host"];

export function defineShard(url) {
  const ids = shard.shardItems(fileURLToPath(url), MUTATIONS).map((mutation) => mutation.id);
  const gaps = ids.filter((id) => UNFELT.includes(id));
  let scratch = null;
  let runtime = null;
  let untouched = null;
  let result = null;

  beforeAll(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), "clay-case-selftest-"));
    const cases = path.join(scratch, "selftest-cases");
    runtime = path.join(scratch, "selftest");
    mkdirSync(cases, { recursive: true });
    for (const name of SUBSET) copyFileSync(path.join(CASES, `${name}.json`), path.join(cases, `${name}.json`));
    untouched = readFileSync(path.join(ROOT, "src/core/save.js"), "utf8");
    result = spawnSync(process.execPath, [CLI, "selftest", "--scratch", runtime, "--cases", cases, "--only", ids.join(",")], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-vm-modules"].filter(Boolean).join(" "), CLAY_COUNTEREXAMPLE_RUNTIME: "" },
    });
  }, 600000);

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test.each(ids)("selftest plants %s in a scratch runtime copy and says whether the corpus feels it", (id) => {
    const output = String(result.stdout ?? "");
    const line = output.split("\n").find((candidate) => candidate.startsWith(id)) ?? "";
    if (UNFELT.includes(id)) expect(line).toContain("NOT CAUGHT");
    else expect(line).toMatch(/ caught by \S+ (failed|invalid)/);
    expect(output).toContain(`${ids.length} mutations: ${ids.length - gaps.length} caught, ${gaps.length} not caught`);
    if (gaps.length) expect(output).toContain(`selftest: the corpus does not feel ${gaps.join(", ")}`);
    expect(result.status).toBe(gaps.length ? 1 : 0);
    expect(readdirSync(runtime).sort()).toEqual([...ids].sort());
    expect(readFileSync(path.join(ROOT, "src/core/save.js"), "utf8")).toBe(untouched);
  });
}

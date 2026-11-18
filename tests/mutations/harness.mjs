// Proves that a test can fail. For each named mutation it copies src/ and one test
// file into a scratch folder outside the repository, runs the named test there to show
// it passes, puts one bug into the copy and runs it again, then takes the bug out and
// runs it a third time. The working tree is never edited.
//
// Exit 0: every asked mutation made its named test fail with the expected message, and
//         the test passed before the bug went in and after it came out.
// Exit 1: a mutation survived (the test still passes, or fails for another reason).
// Exit 2: the harness could not run (a run without the bug failed, a text to replace
//         was not found exactly once, or jest could not load the suite).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = realpathSync(tmpdir());
const COPIED = ["src", "package.json", "tests/jest.setup.js"];

class HarnessError extends Error {}

const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

// A failed test's message without jest's stack lines, indented under the run it belongs
// to. A long diff is cut here and kept whole in the log.
function assertion(test) {
  const lines = plain(test.failureMessages.join("\n")).split("\n");
  const stack = lines.findIndex((line) => /^\s+at /.test(line));
  const shown = lines.slice(0, stack < 0 ? lines.length : stack).filter((line) => line.trim());
  const cut = shown.length > 30 ? [...shown.slice(0, 30), `... ${shown.length - 30} more lines`] : shown;
  return cut.map((line) => `       ${line}`).join("\n");
}

function scratchCopy(extra) {
  const dir = mkdtempSync(join(TMP, "clay-mutation-"));
  for (const name of [...COPIED, ...extra]) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    cpSync(join(ROOT, name), join(dir, name), { recursive: true });
  }
  symlinkSync(realpathSync(join(ROOT, "node_modules")), join(dir, "node_modules"));
  return dir;
}

function runJest(dir, file, name, log, args = []) {
  const out = join(dir, "jest-result.json");
  rmSync(out, { force: true });
  const run = spawnSync(
    process.execPath,
    [join(dir, "node_modules", "jest", "bin", "jest.js"), file, "-t", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "--json", "--outputFile", out, ...args],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-vm-modules"].filter(Boolean).join(" "), FORCE_COLOR: "0" } },
  );
  const said = plain(run.stderr ?? "");
  log.push(said);
  let result;
  try {
    result = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    throw new HarnessError(`jest wrote no result for ${file}:\n${run.error?.message ?? said}`);
  }
  if (result.numRuntimeErrorTestSuites > 0) throw new HarnessError(`jest could not load ${file}:\n${result.testResults.map((t) => plain(t.message)).join("\n")}`);
  const tests = result.testResults.flatMap((t) => t.assertionResults).filter((t) => t.status !== "pending");
  if (!tests.length) throw new HarnessError(`no test in ${file} is named "${name}"`);
  return tests;
}

function green(tests, when) {
  const red = tests.filter((t) => t.status !== "passed");
  if (red.length) throw new HarnessError(`the run ${when} is not green: ${red.map((t) => t.fullName).join("; ")}`);
  return `${tests.length} passed, 0 failed`;
}

function mutateOne(label, m) {
  const dir = scratchCopy([m.test, ...(m.needs ?? [])]);
  const log = [];
  try {
    const before = green(runJest(dir, m.test, m.name, log, m.jestArgs), "before the bug");

    const path = join(dir, m.file);
    const original = readFileSync(path, "utf8");
    let mutated = original;
    for (const [find, replace] of m.edits) {
      const hits = mutated.split(find).length - 1;
      if (hits !== 1) throw new HarnessError(`expected ${JSON.stringify(find)} exactly once in ${m.file}, found it ${hits} times`);
      mutated = mutated.replace(find, () => replace);
    }
    writeFileSync(path, mutated);
    const mutant = runJest(dir, m.test, m.name, log, m.jestArgs);

    writeFileSync(path, original);
    const after = green(runJest(dir, m.test, m.name, log, m.jestArgs), "after the bug came out");

    const failed = mutant.filter((t) => t.status === "failed");
    const expected = failed.filter((t) => m.expects.test(plain(t.failureMessages.join("\n"))));
    console.log(`${label}: ${m.what}`);
    console.log(`  test: ${m.test} -t "${m.name}"`);
    console.log(`  1. without the bug: ${before}`);
    if (!expected.length) {
      console.log(failed.length
        ? `  2. SURVIVED: ${failed.length} test(s) failed, none with ${m.expects}:\n${failed.map(assertion).join("\n")}`
        : `  2. SURVIVED: all ${mutant.length} test(s) still pass with the bug in ${m.file}`);
      return false;
    }
    console.log(`  2. with the bug in ${m.file}: ${mutant.length - failed.length} passed, ${failed.length} failed`);
    for (const t of expected) console.log(assertion(t));
    console.log(`  3. with the bug taken out: ${after}`);
    return true;
  } finally {
    const file = join(TMP, `clay-mutation-${label}.log`);
    writeFileSync(file, log.join("\n----\n"));
    console.log(`  jest output of every run: ${file}`);
    rmSync(dir, { recursive: true, force: true });
  }
}

export function mutate(mutations, asked = process.argv.slice(2)) {
  const names = asked.length ? asked : Object.keys(mutations);
  let survived = 0;
  try {
    for (const name of names) {
      if (!mutations[name]) throw new HarnessError(`unknown mutation "${name}"; known: ${Object.keys(mutations).join(", ")}`);
      if (!mutateOne(name, mutations[name])) survived++;
    }
  } catch (err) {
    if (!(err instanceof HarnessError)) throw err;
    console.error(`harness error: ${err.message}`);
    process.exit(2);
  }
  if (survived) {
    console.log(`${survived} mutation(s) survived`);
    process.exit(1);
  }
  console.log(`${names.length} mutation(s) killed`);
}

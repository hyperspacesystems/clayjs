import { writeFileSync } from "node:fs";
import { drive } from "./driver.mjs";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};

const design = arg("design", "ordered");
const holder = arg("holder", "connected");
const [from, to] = arg("seeds", "1..200").split("..").map(Number);
const steps = Number(arg("steps", 500));
const out = arg("out", "");

const eager = arg("eager", "0") === "1";
const make =
  design === "ordered"
    ? ((orderedDesign) => (mode) => orderedDesign(mode, eager))((await import("./ordered.mjs")).orderedDesign)
    : ((unionDesign) => (mode) => unionDesign(mode, design))((await import("./union.mjs")).unionDesign);

const total = { seeds: to - from + 1, steps, design, holder, eager, window: Number(process.env.LAB_W || 16) };
const sum = { failedStrict: 0, failedKept: 0, holderFailed: 0, holderFailedKept: 0, H3: 0, H9: 0, holderRequired: 0, crashed: 0, native: 0, findings: 0, findingsKept: 0, S1: 0, S2: 0, S3: 0, edits: 0, obligations: 0, released: 0, accepted: 0, refused: 0, losses: 0, notices: 0, copies: 0 };
const outcome = {};
const meta = { compactPadded: 0, padded: 0, stamps: 0 };
const examples = [];
const started = Date.now();

for (let seed = from; seed <= to; seed++) {
  let result;
  try {
    result = drive(await make(holder), seed, steps);
  } catch (error) {
    sum.crashed++;
    sum.failedStrict++;
    sum.failedKept++;
    if (examples.length < 12) examples.push({ seed, crash: error.message.slice(0, 200) });
    continue;
  }
  const second = result.holder.findings;
  if (second.length) sum.holderFailed++;
  if (second.some((finding) => !finding.kept)) sum.holderFailedKept++;
  for (const finding of second) sum[finding.rule]++;
  sum.holderRequired += result.holder.required;
  const open = result.findings.filter((finding) => !finding.kept);
  if (result.findings.length) sum.failedStrict++;
  if (open.length) sum.failedKept++;
  if (result.native) sum.native++;
  sum.findings += result.findings.length;
  sum.findingsKept += result.findings.length - open.length;
  for (const finding of result.findings) sum[finding.rule]++;
  for (const key of ["edits", "obligations", "released", "accepted", "refused", "losses", "notices", "copies"]) sum[key] += result[key];
  for (const [key, value] of Object.entries(result.outcome ?? {})) if (typeof value === "number") outcome[key] = (outcome[key] ?? 0) + value;
  for (const key of Object.keys(meta)) meta[key] = Math.max(meta[key], result.meta?.[key] ?? 0);
  if ((result.findings.length || second.length || result.native) && examples.length < 12) examples.push({ seed, native: result.native, findings: result.findings.slice(0, 3), holder: second.slice(0, 3) });
}

const report = { ...total, ...sum, outcome, meta, examples, ms: Date.now() - started };
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, examples: undefined }));
for (const example of examples.slice(0, 4)) console.log(JSON.stringify(example).slice(0, 400));

import { writeFileSync } from "node:fs";
import { run } from "./union-probe.mjs";

const [from, to] = (process.argv[2] || "1..200").split("..").map(Number);
const steps = Number(process.argv[3] || 500);
const out = process.argv[4];
const failed = [];
const started = Date.now();
for (let seed = from; seed <= to; seed++) {
  try {
    run(seed, steps);
  } catch (error) {
    failed.push({ seed, message: error.message.slice(0, 160) });
  }
}
const classes = {};
for (const { message } of failed) classes[message.split(" ")[0]] = (classes[message.split(" ")[0]] ?? 0) + 1;
const report = { rules: process.env.UNION === "1" ? "union" : "current", holderOracle: process.env.STRICT_ACK === "1", seeds: to - from + 1, steps, failures: failed.length, classes, failed: failed.slice(0, 40), ms: Date.now() - started };
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, failed: failed.slice(0, 5) }));

import { usePlant } from "../core/planted.mjs";
import { failing, shrink, attempt } from "./shrink.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const seed = Number(args.seed ?? 1);
const steps = Number(args.steps ?? 400);
const options = { mode: args.mode ?? "ordered", seed, profile: args.profile, without: args.without ? args.without.split(",") : [] };
if (args.ledgerCap) options.ledgerCap = Number(args.ledgerCap);
usePlant(args.plant ?? "");

const error = failing(seed, steps, options);
if (!error) {
  console.log(`seed ${seed} passes at ${steps} moves (${options.mode})`);
  process.exit(0);
}
console.log(`seed ${seed} fails at move ${error.move ?? "end"}: ${error.message}`);
let moves = error.moves;
let last = error;
if (args.shrink !== "0") {
  const small = shrink(moves, options);
  moves = small.moves;
  last = small.error;
  console.log(`shrunk from ${error.moves.length} to ${moves.length} moves: ${last.message}`);
}
const lines = [];
const noted = attempt(moves, { ...options, note: (...parts) => lines.push(parts.join(" ")) });
for (const line of lines) console.log(line);
console.log(noted ? noted.stack.split("\n").slice(0, 8).join("\n") : "the shrunk moves pass under tracing");
if (args.json) console.log(JSON.stringify(moves));

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = process.argv[2];
if (!log) {
  console.error('usage: node scripts/jest-durations.mjs test-box-out/<run>/jest-files.jsonl');
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const table = path.join(root, 'tests/jest-durations.json');
const durations = JSON.parse(readFileSync(table, 'utf8'));
let timed = 0;
for (const line of readFileSync(log, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const event = JSON.parse(line);
  if (event.e !== 'end' || event.failed) continue;
  durations[event.file] = Math.max(1, Math.round(event.ms / 1000));
  timed += 1;
}
for (const file of Object.keys(durations)) if (!existsSync(path.join(root, file))) delete durations[file];
const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
writeFileSync(table, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${timed} file times read; tests/jest-durations.json lists ${Object.keys(sorted).length} files`);

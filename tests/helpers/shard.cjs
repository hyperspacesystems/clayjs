const fs = require('node:fs');
const path = require('node:path');

function shardItems(file, items, weightOf = () => 1) {
  const match = /^(.*)-(\d+)(\.test\.[cm]?js)$/.exec(path.basename(file));
  if (!match) throw new Error(`shard files are named <base>-<n>.test.js, not ${path.basename(file)}`);
  const [, base, own, ext] = match;
  const numbers = fs.readdirSync(path.dirname(file))
    .filter((name) => name.startsWith(`${base}-`) && name.endsWith(ext))
    .map((name) => Number(name.slice(base.length + 1, -ext.length)))
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  if (numbers.some((n, i) => n !== i + 1)) throw new Error(`${base} shard files must be numbered 1 to N with none missing, found ${numbers.join(', ')}`);
  const loads = numbers.map(() => 0);
  const mine = [];
  const order = items.map((item, index) => ({ item, index, weight: weightOf(item) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const entry of order) {
    let lightest = 0;
    for (let i = 1; i < loads.length; i += 1) if (loads[i] < loads[lightest]) lightest = i;
    loads[lightest] += entry.weight;
    if (lightest === Number(own) - 1) mine.push(entry);
  }
  return mine.sort((a, b) => a.index - b.index).map((entry) => entry.item);
}

module.exports = { shardItems };

import { rng } from "../lib.mjs";

export const FIELDS = [];
for (let r = 1; r <= 4; r++) for (let c = 1; c <= 3; c++) FIELDS.push(`r${r}/c${c}`);

export function drive(design, seed, steps) {
  const rnd = rng(seed);
  design.join();
  design.join();
  let value = 0;
  for (let i = 0; i < steps; i++) {
    const x = rnd();
    const a = rnd();
    const b = rnd();
    const c = rnd();
    const tabs = design.live();
    if (!tabs.length) {
      design.join();
      continue;
    }
    const tab = tabs[Math.floor(a * tabs.length)];
    if (x < 0.34) design.edit(tab, FIELDS[Math.floor(b * FIELDS.length)], `v${++value}`);
    else if (x < 0.54) design.toRoom(tab);
    else if (x < 0.78) design.toTab(tab);
    else if (x < 0.82) design.toggle(tab);
    else if (x < 0.88) design.checkpoint(b < 0.6);
    else if (x < 0.94) design.answer(b < 0.15);
    else if (x < 0.96) {
      if (tabs.length < 5) design.join();
    } else if (x < 0.98) {
      if (tabs.length > 1) design.close(tab);
      else if (b < 0.5) design.endRoom(tab, c < 0.5);
    } else if (x < 0.99) design.roomLoss();
    design.check(i);
  }
  return design.finish();
}

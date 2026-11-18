import { codec } from "./codec.mjs";

export const seenBy = (wb, action) => codec().seen(wb, action);

export const rowsOf = (action) => codec().needs(action);

export const createsOf = (action) => (action ? codec().creates(action) : []);

export const removesOf = (action) => (action ? codec().removes(action) : []);

export const has = (wb, id) => codec().has(wb, id);

export const fitsNow = (wb, action) => codec().fits(wb, action);

export const marksOf = (action) => [...codec().creates(action), ...codec().targets(action)];

export function waitsFor(wb, action, waiting) {
  const mark = rowsOf(action).find((row) => !has(wb, row) && waiting.has(row)) ?? codec().targets(action).find((key) => waiting.has(key));
  return mark === undefined ? null : waiting.get(mark);
}

export const conflicts = (wb, action, saw) => codec().conflicts(wb, action, saw);

export const unseenBy = (wb, action, saw) => codec().unseen(wb, action, saw);

export function lateCells(wb, action, saw) {
  const changed = conflicts(wb, action, saw);
  return changed.length ? changed : conflicts(wb, action, null);
}

export const reviewed = (action, saw, cells) => codec().review(action, saw, cells);

export function stillOpen(wb, action, saw, looked) {
  const cells = conflicts(wb, action, saw);
  return cells.length && looked && !conflicts(wb, action, looked).length ? [] : cells;
}

export const holds = (wb, action) => codec().holds(wb, action);

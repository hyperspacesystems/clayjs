import { planted } from "./planted.mjs";
import { opsOf, frameBytes } from "./limits.mjs";

const flat = (frame) => frame.k !== "adopt";

const big = (frame) => (flat(frame) ? frame.action : frame.items.length === 1 ? frame.items[0].action : null);

const sawOf = (frame) => (flat(frame) ? frame.saw : frame.items[0].saw);

const withAction = (frame, action, saw) => (flat(frame) ? { ...frame, action, saw } : { ...frame, items: [{ ...frame.items[0], action, saw }] });

const reviewedOf = (frame) => (flat(frame) ? frame.reviewed : frame.items[0].reviewed);

const withReviewed = (frame, reviewed) => (!reviewedOf(frame) ? frame : flat(frame) ? { ...frame, reviewed } : { ...frame, items: [{ ...frame.items[0], reviewed }] });

export function explode(frame, key, limits) {
  const action = big(frame);
  if (!action || opsOf(action) <= limits.opsPerFrame || planted("oversize-frame")) return [frame];
  const count = Math.ceil(action.cells.length / limits.opsPerFrame);
  const saw = sawOf(frame);
  const reviewed = reviewedOf(frame);
  const bare = withReviewed(withAction(frame, { ...action, cells: [] }, saw && []), []);
  return Array.from({ length: count }, (_, i) => ({
    k: "part",
    gen: frame.gen,
    of: frame.k,
    from: frame.from,
    key,
    order: flat(frame) ? { c: frame.c, p: frame.p } : { from: frame.from, n: frame.items[0].n },
    i,
    m: count,
    size: frameBytes(action, { saw, reviewed }),
    frame: i ? null : bare,
    cells: action.cells.slice(i * limits.opsPerFrame, (i + 1) * limits.opsPerFrame),
    saw: saw?.slice(i * limits.opsPerFrame, (i + 1) * limits.opsPerFrame),
    reviewed: reviewed?.slice(i * limits.opsPerFrame, (i + 1) * limits.opsPerFrame),
  }));
}

export function assemble(parts) {
  const bare = parts.find((part) => part?.frame).frame;
  const whole = withAction(bare, { ...big(bare), cells: parts.flatMap((part) => part?.cells ?? []) }, sawOf(bare) && parts.flatMap((part) => part?.saw ?? []));
  return withReviewed(whole, parts.flatMap((part) => part?.reviewed ?? []));
}

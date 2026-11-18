import { planted } from "./planted.mjs";
import { opsOf, frameBytes } from "./limits.mjs";
import { codec } from "./codec.mjs";

const flat = (frame) => frame.k !== "adopt";

const big = (frame) => (flat(frame) ? frame.action : frame.items.length === 1 ? frame.items[0].action : null);

const sawOf = (frame) => (flat(frame) ? frame.saw : frame.items[0].saw);

const withAction = (frame, action, saw) => (flat(frame) ? { ...frame, action, saw } : { ...frame, items: [{ ...frame.items[0], action, saw }] });

const reviewedOf = (frame) => (flat(frame) ? frame.reviewed : frame.items[0].reviewed);

const withReviewed = (frame, reviewed) => (!reviewedOf(frame) ? frame : flat(frame) ? { ...frame, reviewed } : { ...frame, items: [{ ...frame.items[0], reviewed }] });

export function explode(frame, key, limits) {
  const action = big(frame);
  if (!action || opsOf(action) <= limits.opsPerFrame || planted("oversize-frame")) return [frame];
  const saw = sawOf(frame);
  const reviewed = reviewedOf(frame);
  const { head, parts } = codec().split({ action, saw, reviewed }, limits);
  const bare = withReviewed(withAction(frame, head.action, head.saw), head.reviewed);
  const size = frameBytes(action, { saw, reviewed });
  const order = () => (flat(frame) ? { c: frame.c, p: frame.p } : { from: frame.from, n: frame.items[0].n });
  return parts.map((body, i) => ({ k: "part", gen: frame.gen, of: frame.k, from: frame.from, key, order: order(), i, m: parts.length, size, frame: i ? null : bare, ...body }));
}

export function assemble(parts) {
  const bare = parts.find((part) => part?.frame).frame;
  const whole = codec().assemble({ action: big(bare), saw: sawOf(bare), reviewed: reviewedOf(bare) }, parts);
  const merged = withAction(bare, whole.action, whole.saw);
  return whole.reviewed == null ? merged : flat(merged) ? { ...merged, reviewed: whole.reviewed } : { ...merged, items: [{ ...merged.items[0], reviewed: whole.reviewed }] };
}

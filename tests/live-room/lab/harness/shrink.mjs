import { run, runMoves } from "./gen.mjs";

export const failureClass = (error) => error.message.split(/[ :]/)[0];

export function attempt(moves, options) {
  try {
    runMoves(moves, options);
    return null;
  } catch (error) {
    return error;
  }
}

export function failing(seed, steps, options = {}) {
  try {
    run(seed, steps, { ...options, seed });
    return null;
  } catch (error) {
    return error;
  }
}

export function shrink(moves, options, want) {
  let best = moves.slice();
  let error = attempt(best, options);
  if (!error) return { moves: best, error: null };
  const kind = want ?? failureClass(error);
  for (let size = Math.ceil(best.length / 2); size >= 1; size = size === 1 ? 0 : Math.ceil(size / 2)) {
    for (let at = 0; at < best.length; ) {
      const next = [...best.slice(0, at), ...best.slice(at + size)];
      const found = attempt(next, options);
      if (found && failureClass(found) === kind) {
        best = next;
        error = found;
      } else {
        at += size;
      }
    }
  }
  return { moves: best, error };
}

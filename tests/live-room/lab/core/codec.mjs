let current = null;

export function useCodec(next) {
  current = next;
}

export const codec = () => current;

export const act = (wb, action) => current.apply(wb, action).out === "applied";

let codec = null;

export function useCodec(next) {
  codec = next;
}

export const act = (wb, action) => codec.act(wb, action);

import { createRooms, LIVE_LIMITS } from '../../../src/server/rooms/index.js';

test('Astra 6 / Sonnet 7: sixteen stores of 4096 tiny moves fit the serialized 1 MiB budget', () => {
  const rooms = createRooms({ newEpoch: () => 'e1' });
  const names = Array.from({ length: 16 }, (_, i) => `s${i}`);
  const room = rooms.open('k', names.map((name) => `<script type="application/json" merge="${name}" clay="live">{}</script>`).join(''));
  let accepted = 0;
  for (const name of names) for (let n = 1; n <= 4096; n++) {
    const ops = n % 2 ? [{ op: 'set', path: ['x'], value: 1 }] : [{ op: 'del', path: ['x'] }];
    const result = rooms.apply(room, 'a', { name, n, ops });
    if (result.seq !== undefined) accepted++;
  }
  expect(accepted).toBe(16 * 4096);
  const state = rooms.state(room, 'a', null);
  expect(Object.values(state.moves).filter(Array.isArray).length).toBeGreaterThan(0);
  expect(Object.values(state.moves).filter((x) => x === null).length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(state.moves), 'utf8')).toBeLessThanOrEqual(LIVE_LIMITS.movesBytes);
  const caught = rooms.state(room, 'a', { epoch: room.epoch, seq: room.seq });
  expect(Object.values(caught.moves)).toEqual(names.map(() => []));
});

test('the move budget includes UTF-8 text, store keys and array/object punctuation', () => {
  const rooms = createRooms({ newEpoch: () => 'e1' });
  const room = rooms.open('k', '<script type="application/json" merge="s" clay="live">{}</script>');
  const store = room.stores.get('s');
  const move = (text) => ({ seq: 1, ops: [{ op: 'set', path: ['x'], value: text }] });
  const overhead = Buffer.byteLength(JSON.stringify({ s: [move('')] }));
  for (const extra of [-1, 0, 1]) {
    const payload = '漢' + 'x'.repeat(LIVE_LIMITS.movesBytes - overhead - 3 + extra);
    const entry = { ...move(payload), bytes: 0 };
    store.log = [entry]; store.last = 1; room.seq = 1;
    const state = rooms.state(room, 'a', null);
    expect(Array.isArray(state.moves.s)).toBe(extra <= 0);
    expect(Buffer.byteLength(JSON.stringify(state.moves))).toBeLessThanOrEqual(LIVE_LIMITS.movesBytes);
  }
});

import { createRooms, LIVE_LIMITS } from '../../../src/server/rooms/index.js';
import { serializeLive, stampOf } from '../../../src/server/rooms/index.js';
import { saveReceipt, receiptBytes } from '../../../src/server/rooms/index.js';

const html = (value, by = null, seq = 0) => `<script type="application/json" merge="s" clay="live" live-at="${stampOf('e1', seq, serializeLive(value))}"${by ? ` live-by="${by}"` : ''}>${serializeLive(value)}</script>`;
const frame = (generation = 0, n = 1) => ({ name: 's', n, epoch: 'e1', receiptGeneration: generation, ops: [{ op: 'add', path: ['n'], n: 1 }] });

test('retiring a saved receipt admits new readers and refuses forgotten POSTs', () => {
  const rooms = createRooms({ newEpoch: () => 'e1' });
  const room = rooms.open('doc', html({ n: 0 }));
  for (let i = 0; i < LIVE_LIMITS.receipts; i++) {
    rooms.fileWritten('doc', html({ n: 0, i }, `v2|c${i}:2||save${i}:1`, room.seq));
  }
  expect(room.lastN.size).toBe(LIVE_LIMITS.receipts);
  expect(rooms.apply(room, 'fresh', frame(), { connected: ['fresh'] }).seq).toBeDefined();
  expect(room.receiptsBlocked).toBeUndefined();
  const before = room.stores.get('s').value.n;
  expect(rooms.apply(room, 'c0', frame(0, 2))).toEqual({ error: 'receipt-expired' });
  expect(room.stores.get('s').value.n).toBe(before);
  for (let i = 0; i < 4; i++) {
    const state = rooms.state(room, `fresh${i}`, null);
    expect(state.provenanceVersion).toBe(2);
    expect(rooms.apply(room, `fresh${i}`, frame(state.receiptGeneration), { connected: [`fresh${i}`] }).seq).toBeDefined();
  }
  expect(room.lastN.size).toBe(LIVE_LIMITS.receipts);
  expect(room.receiptBytes).toBe([...room.lastN.values()].reduce((n, r) => n + receiptBytes(r), 0));
});

test('an evicted sender can save again without closing admission', () => {
  const rooms = createRooms({ newEpoch: () => 'e1' });
  const room = rooms.open('doc', html({ n: 0 }));
  for (let i = 0; i < LIVE_LIMITS.receipts; i++) rooms.apply(room, `c${i}`, frame());
  rooms.apply(room, 'fresh', frame(), { connected: ['fresh'] });
  rooms.fileWritten('doc', html({ n: 3 }, 'v2|c0:1||saveC0:1', room.seq));
  expect(room.receiptsBlocked).toBeUndefined();
  expect(rooms.apply(room, 'c0', frame()).duplicate).toBe(true);
  const state = rooms.state(room, 'next', null);
  expect(rooms.apply(room, 'next', frame(state.receiptGeneration), { connected: ['next'] }).seq).toBeDefined();
  expect(room.stores.get('s').value.n).toBe(4);
});

test('range exhaustion advances the barrier without inventing receipt coverage', () => {
  const room = { lastN: new Map() };
  saveReceipt(room, 's\na', Array.from({ length: 256 }, (_, i) => [2 * i + 2, 2 * i + 2]), 1, 4096);
  saveReceipt(room, 's\na', [[514, 514]], 2, 4096);
  const receipt = room.lastN.get('s\na');
  expect(room.receiptGeneration).toBe(1);
  expect(receipt.saved).toHaveLength(256);
  expect(receipt.saved[0]).toEqual([4, 4]);
  expect(receipt.blocked).toBeUndefined();
  expect(room.receiptBytes).toBe(receiptBytes(receipt));
});

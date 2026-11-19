import { createRooms, liveTags, LIVE_LIMITS } from '../../../src/server/rooms/index.js';
import { serializeLive, stampOf } from '../../../src/server/rooms/index.js';
import { mergeFile } from '../page/collab/file-merge.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const html = (value, stamp = null, by = null) => `<script type="application/json" merge="s" clay="live"${stamp ? ` live-at="${stamp}"` : ''}${by ? ` live-by="${by}"` : ''}>${serializeLive(value)}</script>`;
const copyRoom = (room) => ({
  epoch: room.epoch, seq: room.seq, receiptsBlocked: room.receiptsBlocked, receiptBytes: room.receiptBytes,
  lastN: new Map([...room.lastN].map(([k, v]) => [k, clone(v)])),
  stores: new Map([...room.stores].map(([k, v]) => [k, { ...clone({ ...v, inFile: undefined }), inFile: new Set(v.inFile) }])),
});
const snapshot = (room) => ({
  seq: room.seq, receiptsBlocked: !!room.receiptsBlocked, receiptBytes: room.receiptBytes ?? 0,
  lastN: [...room.lastN],
  stores: [...room.stores].map(([k, s]) => [k, { ...s, inFile: [...s.inFile].sort((a, b) => a - b) }]),
});

test('Sonnet 8: server and sibling double agree on exact provenance, legacy, restores and eviction', () => {
  const counts = { saves: 0, exact: 0, legacy: 0, plain: 0, staleHash: 0, restored: 0, seedEpoch: 0, floor: 0 };
  for (let seed = 1; seed <= 60; seed++) {
    let random = seed;
    const R = () => ((random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 4294967296);
    const rooms = createRooms({ newEpoch: () => 'e1' });
    const initial = { n: 0, k: {} };
    const room = rooms.open('k', html(initial, stampOf('seed', 3, serializeLive(initial))));
    const history = [{ seq: 0, value: initial }];
    const sent = { a: 0, b: 0 };
    for (let step = 0; step < 72; step++) {
      if (step % 3 !== 2) {
        const client = R() < 0.5 ? 'a' : 'b';
        const ops = step % 5 === 0 ? [{ op: 'set', path: ['k', 'large'], value: String(step).padEnd(40000, 'x') }] : [{ op: 'add', path: ['n'], n: 1 }];
        const result = rooms.apply(room, client, { name: 's', n: ++sent[client], ops });
        expect(result.seq).toBeGreaterThan(0);
        history.push({ seq: room.seq, value: clone(room.stores.get('s').value) });
        continue;
      }
      const h = history[Math.floor(R() * history.length)];
      const value = clone(h.value);
      value.k.note = step;
      const kind = Math.floor(step / 3) % 6;
      const restored = Math.floor(step / 3) % 7 === 0;
      const client = R() < 0.5 ? 'a' : 'b';
      const n = Math.max(1, sent[client]);
      const by = kind === 0 || kind === 3 || kind === 4 ? `v2|${client}:${n}||capture${seed}:${step}` : kind === 1 ? `${client}:${n}` : null;
      const text = serializeLive(value);
      const stamp = kind === 2 ? null : stampOf(kind === 4 ? 'seed' : 'e1', kind === 4 ? 4 : h.seq, kind === 3 ? text + ' ' : text);
      const fileHtml = html(value, stamp, by);
      const tag = liveTags(fileHtml)[0];
      const double = copyRoom(room);
      mergeFile(double, 's', { value, at: tag.at, by: tag.by }, { limits: LIVE_LIMITS, restored });
      rooms.fileWritten('k', fileHtml, { restored });
      expect(snapshot(double)).toEqual(snapshot(room));
      expect(rooms.used()).toBe([...room.stores.values()].reduce((n, s) => n + s.bytes + s.logBytes, room.receiptBytes ?? 0));
      counts.saves++;
      if (by?.startsWith('v2|')) counts.exact++;
      else if (by) counts.legacy++;
      else counts.plain++;
      if (kind === 3) counts.staleHash++;
      if (kind === 4) counts.seedEpoch++;
      if (restored) counts.restored++;
      if (room.stores.get('s').landed === -1) counts.floor++;
    }
  }
  expect(counts.saves).toBe(1440);
  for (const [name, count] of Object.entries(counts)) expect({ name, positive: count > 0 }).toEqual({ name, positive: true });
});

test('the comparison detects a double that incorrectly honors restored provenance', () => {
  const rooms = createRooms({ newEpoch: () => 'e1' });
  const room = rooms.open('k', html({ n: 0 }));
  rooms.apply(room, 'a', { name: 's', n: 1, ops: [{ op: 'add', path: ['n'], n: 1 }] });
  const saved = html({ n: 1 }, stampOf('e1', 0, serializeLive({ n: 1 })), 'v2|a:1||capture:1');
  const tag = liveTags(saved)[0];
  const wrong = copyRoom(room);
  mergeFile(wrong, 's', { value: { n: 1 }, at: tag.at, by: tag.by }, { limits: LIVE_LIMITS, restored: false });
  rooms.fileWritten('k', saved, { restored: true });
  expect(wrong.stores.get('s').value.n).toBe(1);
  expect(room.stores.get('s').value.n).toBe(2);
  expect(snapshot(wrong)).not.toEqual(snapshot(room));
});

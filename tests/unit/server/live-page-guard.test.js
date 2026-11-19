import { createRooms, LIVE_LIMITS } from '../../../src/server/rooms/index.js';
import { serializeLive } from '../../../src/server/rooms/index.js';
import { isYPageValue } from '../../../src/server/rooms/index.js';

const yvalue = () => ({ v: 1, g: 0, y: { seed: 'opaque' } });
const hybrid = () => ({ blocks: { p: { t: 'paragraph', pos: 'A', c: 'AAAA' } } });
const tag = (name, value) => `<script type="application/json" merge="${name}" clay="live">${serializeLive(value)}</script>`;
const html = (value = yvalue(), counter = 0) => tag('blockeditor', value) + tag('counter', { n: counter });
const set = (key, value) => ({ op: 'set', path: ['y', key], value });
const del = (key) => ({ op: 'del', path: ['y', key] });

function setup(value = yvalue()) {
  const rooms = createRooms({ newEpoch: () => 'e1' });
  const room = rooms.open('doc', html(value), { nodeId: 1 });
  const frame = (ops, n = 1, extra = {}) => ({ name: 'blockeditor', n, ops, epoch: room.epoch, blockeditorGeneration: room.blockeditorTransition?.id, ...extra });
  const unchanged = () => JSON.stringify([rooms.state(room, 'peer', null), [...room.lastN], rooms.used()]);
  return { rooms, room, frame, unchanged };
}

test('a cold saved Yjs page reconstructs a counted format generation', () => {
  const { rooms, room } = setup();
  const state = rooms.state(room, 'peer');
  expect(state.blockeditorTransition).toEqual({ v: 2, id: expect.any(String), format: 'yjs', sources: [], receipts: {}, history: [] });
  expect(room.blockeditorTransition.bytes).toBeGreaterThan(0);
  expect(rooms.used()).toBeGreaterThan([...room.stores.values()].reduce((n, store) => n + store.bytes, 0));
  rooms.drop('doc');
  expect(rooms.used()).toBe(0);
});

test.each([undefined, null, 'old-generation'])('a missing or stale generation %s refuses before mutation', (blockeditorGeneration) => {
  const { rooms, room, frame, unchanged } = setup();
  const before = unchanged();
  expect(rooms.apply(room, 'peer', frame([set('next', 'update')], 1, { blockeditorGeneration }))).toEqual({ error: 'blockeditor-generation' });
  expect(unchanged()).toBe(before);
});

test.each([
  ['Yjs root replacement', { op: 'set', path: [], value: yvalue() }],
  ['hybrid root replacement', { op: 'set', path: [], value: hybrid() }],
  ['update map replacement', { op: 'set', path: ['y'], value: {} }],
  ['envelope removal', { op: 'del', path: ['v'] }],
  ['version change', { op: 'set', path: ['v'], value: 2 }],
  ['legacy generation change', { op: 'set', path: ['g'], value: 2 }],
  ['hybrid field', { op: 'set', path: ['blocks'], value: {} }],
  ['numeric add', { op: 'add', path: ['y', 'next'], n: 1 }],
  ['non-string update', { op: 'set', path: ['y', 'next'], value: {} }],
  ['nested update', { op: 'set', path: ['y', 'next', 'nested'], value: 'update' }],
])('%s is refused without a receipt or state change', (_label, op) => {
  const { rooms, room, frame, unchanged } = setup();
  const before = unchanged();
  expect(rooms.apply(room, 'peer', frame([op]))).toEqual({ error: 'blockeditor-format' });
  expect(unchanged()).toBe(before);
});

test('valid leaf updates carry the generation, and duplicates retain normal receipts', () => {
  const { rooms, room, frame } = setup();
  const update = frame([set('next', 'update')]);
  const result = rooms.apply(room, 'peer', update);
  expect(result).toMatchObject({ seq: 1, blockeditorGeneration: room.blockeditorTransition.id });
  expect(rooms.apply(room, 'peer', update)).toEqual({ duplicate: true, seq: 1, epoch: room.epoch });
  expect(rooms.apply(room, 'peer', { ...update, blockeditorGeneration: 'old' })).toEqual({ error: 'blockeditor-generation' });
  expect(room.seq).toBe(1);
  expect(room.stores.get('blockeditor').value.y.next).toBe('update');
});

test('multipart arrival and deletion are legal before all parts are present', () => {
  const { rooms, room, frame } = setup();
  expect(rooms.apply(room, 'peer', frame([set('u.1.2', 'second')], 1)).seq).toBe(1);
  expect(isYPageValue(room.stores.get('blockeditor').value)).toBe(false);
  expect(rooms.apply(room, 'peer', frame([set('u.0.2', 'first')], 2)).seq).toBe(2);
  expect(isYPageValue(room.stores.get('blockeditor').value)).toBe(true);
  expect(rooms.apply(room, 'peer', frame([del('u.1.2')], 3)).seq).toBe(3);
  expect(isYPageValue(room.stores.get('blockeditor').value, { complete: false })).toBe(true);
});

test('compaction may install a fold and delete every original update including the seed', () => {
  const { rooms, room, frame } = setup();
  expect(rooms.apply(room, 'peer', frame([set('m.0.2', 'first'), set('m.1.2', 'second')], 1)).seq).toBe(1);
  expect(rooms.apply(room, 'peer', frame([del('seed')], 2)).seq).toBe(2);
  expect(room.stores.get('blockeditor').value.y).toEqual({ 'm.0.2': 'first', 'm.1.2': 'second' });
  expect(rooms.apply(room, 'peer', frame([del('m.0.2'), del('m.1.2')], 3)).seq).toBe(3);
  expect(room.stores.get('blockeditor').value.y).toEqual({});
});

test.each([
  [set('seed.0.2', 'alias')],
  [set('u.2.2', 'out-of-range')],
  [set('u.0.2', 'first'), set('u.1.3', 'inconsistent')],
  [set('u.0.2', 'first'), set('u.00.2', 'duplicate-index')],
].map((ops) => [ops]))('invalid multipart structure rolls back every tentative change: %j', (ops) => {
  const { rooms, room, frame, unchanged } = setup();
  const before = unchanged();
  expect(rooms.apply(room, 'peer', frame(ops))).toEqual({ error: 'blockeditor-format' });
  expect(unchanged()).toBe(before);
});

test('ordinary own keys and normalized dotted paths remain valid update names', () => {
  const { rooms, room, frame } = setup();
  expect(rooms.apply(room, 'peer', frame([set('__proto__', 'own'), set('constructor', 'own'), set(0, 'numeric'), { op: 'set', path: 'y.dotted', value: 'text' }])).seq).toBe(1);
  const value = room.stores.get('blockeditor').value;
  expect(Object.hasOwn(value.y, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(value.y)).toBe(Object.prototype);
  expect(value.y[0]).toBe('numeric');
  expect(value.y.dotted).toBe('text');
});

test('retired source names and file-mode pages keep the generation fence', () => {
  const { rooms, room, frame } = setup({ v: 1, y: { seed: 'x'.repeat(LIVE_LIMITS.storeBytes + 1) } });
  expect(room.stores.has('blockeditor')).toBe(false);
  expect(rooms.state(room).blockeditorTransition.format).toBe('yjs');
  expect(rooms.apply(room, 'peer', frame([set('next', 'text')], 1, { blockeditorGeneration: undefined }))).toEqual({ error: 'blockeditor-generation' });
  expect(rooms.apply(room, 'peer', frame([set('next', 'text')]))).toEqual({ error: 'unknown-store' });
  expect(rooms.apply(room, 'peer', frame([set('next', 'text')], 1, { name: 'blockeditor.1' }))).toEqual({ error: 'blockeditor-format' });
});

test('a recreated room rejects its prior page generation even with the same injected epoch', () => {
  const { rooms, room, frame } = setup();
  const old = frame([set('next', 'text')]);
  const next = rooms.reset('doc', html(), { nodeId: 1 });
  expect(next.epoch).toBe(room.epoch);
  expect(next.blockeditorTransition.id).not.toBe(old.blockeditorGeneration);
  expect(rooms.apply(next, 'peer', old)).toEqual({ error: 'blockeditor-generation' });
  expect(rooms.apply(next, 'peer', { ...old, blockeditorGeneration: next.blockeditorTransition.id }).seq).toBe(1);
  rooms.drop('doc');
  expect(rooms.used()).toBe(0);
});

test.each([
  [{ op: 'set', path: [], value: yvalue() }],
  [{ op: 'set', path: ['y'], value: { seed: 'opaque' } }],
  [{ op: 'set', path: ['v'], value: 1 }],
].map((ops) => [ops]))('hybrid page frames cannot initiate a format conversion: %j', (ops) => {
  const { rooms, room, frame, unchanged } = setup(hybrid());
  const before = unchanged();
  expect(rooms.apply(room, 'peer', frame(ops))).toEqual({ error: 'blockeditor-conversion-required' });
  expect(unchanged()).toBe(before);
});

test('generic page data keeps ordinary operations but cannot introduce a Yjs envelope', () => {
  const { rooms, room, frame } = setup({ y: 4, v: 7, count: 0 });
  expect(room.blockeditorTransition).toBeUndefined();
  expect(rooms.apply(room, 'peer', frame([{ op: 'add', path: ['count'], n: 1 }])).seq).toBe(1);
  expect(rooms.apply(room, 'peer', frame([{ op: 'set', path: [], value: yvalue() }], 2))).toEqual({ error: 'blockeditor-conversion-required' });
  expect(room.stores.get('blockeditor').value).toEqual({ y: 4, v: 7, count: 1 });
});

test('a rejected frame at receipt capacity does not evict proof or advance the receipt generation', () => {
  const { rooms, room, frame, unchanged } = setup();
  for (let i = 0; i < LIVE_LIMITS.receipts; i++) {
    expect(rooms.apply(room, `c${i}`, { name: 'counter', n: 1, ops: [{ op: 'add', path: ['n'], n: 0 }] }).seq).toBeDefined();
  }
  const before = unchanged();
  expect(rooms.apply(room, 'peer', frame([set('seed.0.2', 'alias')]))).toEqual({ error: 'blockeditor-format' });
  expect(unchanged()).toBe(before);
  expect(rooms.apply(room, 'new', { name: 'counter', n: 1, ops: [{ op: 'add', path: ['n'], n: 'invalid' }] }).error).toBe('bad-op');
  expect(unchanged()).toBe(before);
  expect(rooms.apply(room, 'peer', frame([set('next', 'accepted')])).seq).toBe(LIVE_LIMITS.receipts + 1);
  expect(room.receiptGeneration).toBe(1);
  expect(room.lastN.has('counter\nc0')).toBe(false);
});

test('late incompatible file notifications cannot reintroduce hybrid state', () => {
  const { rooms, room } = setup();
  const page = room.stores.get('blockeditor');
  const generation = room.blockeditorTransition.id;
  rooms.fileWritten('doc', html(hybrid(), 5));
  expect(room.stores.get('blockeditor')).toBe(page);
  expect(page.value).toEqual(yvalue());
  expect(page.log).toEqual([]);
  expect(room.blockeditorTransition.id).toBe(generation);
  expect(room.stores.get('counter').value.n).toBe(5);
});

test('a file notification cannot bypass conversion admission on a hybrid room', () => {
  const { rooms, room } = setup(hybrid());
  rooms.fileWritten('doc', html(yvalue(), 5));
  expect(room.stores.get('blockeditor').value).toEqual(hybrid());
  expect(room.stores.get('counter').value.n).toBe(5);
  expect(room.blockeditorTransition).toBeUndefined();
});

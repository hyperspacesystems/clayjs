import { jest, test, expect } from '@jest/globals';
import { createRooms } from '../../../src/server/rooms/index.js';
import { createFastLane } from '../../../src/live/fast-lane.js';
import { createStore } from '../../../src/live/store.js';

test.each(['blockeditor', 'blockeditor.2'])('the installed client sends the actual room epoch for %s', async (name) => {
  jest.useFakeTimers();
  const value = { blocks: { p: { t: 'paragraph', pos: 'A', c: 'before' } } };
  const rooms = createRooms({ newEpoch: () => 'installed-client-epoch' });
  const room = rooms.open('doc', `<script type="application/json" clay="live" merge="${name}">${JSON.stringify(value)}</script>`, { nodeId: 1 });
  const store = createStore({ name, value });
  const sent = [];
  let handlers;
  const lane = createFastLane({
    entries: new Map([[name, { store }]]),
    transport: {
      start(next) { handlers = next; return () => {}; },
      async fetchState(clientId) { return { ...rooms.state(room, clientId), conn: 'connected-tab' }; },
      async send(clientId, frame) {
        const result = rooms.apply(room, clientId, frame);
        sent.push({ frame, result });
        if (result.seq) handlers.frame({ ...result, from: clientId, n: frame.n });
        return { status: 200, body: result };
      },
    },
  });
  store.onLocal((ops) => lane.local(name, ops, store.mark));
  try {
    lane.start();
    handlers.open({ clientId: 'installed-client' });
    await jest.advanceTimersByTimeAsync(0);
    expect(lane.status.synced).toBe(true);
    store.handle.set(['blocks', 'p', 'c'], 'after');
    await jest.advanceTimersByTimeAsync(50);
    expect(sent).toHaveLength(1);
    expect(sent[0].frame).toMatchObject({ name, epoch: room.epoch, conn: 'connected-tab', n: 1 });
    expect(sent[0].result).toMatchObject({ epoch: room.epoch, seq: 1 });
    expect(room.stores.get(name).value.blocks.p.c).toBe('after');
    expect(store.pending).toEqual([]);
  } finally {
    lane.stop();
    jest.useRealTimers();
  }
});

test('the installed client keeps editing a hybrid page after Restore', async () => {
  jest.useFakeTimers();
  const name = 'blockeditor';
  const value = { blocks: { p: { t: 'paragraph', pos: 'A', c: 'before' } } };
  const restored = { blocks: { p: { t: 'paragraph', pos: 'A', c: 'restored' } } };
  const html = (page) => `<script type="application/json" clay="live" merge="blockeditor">${JSON.stringify(page)}</script>`;
  const rooms = createRooms({ newEpoch: () => 'installed-client-epoch' });
  const room = rooms.open('doc', html(value), { nodeId: 1 });
  const store = createStore({ name, value });
  const sent = [];
  let handlers;
  const lane = createFastLane({
    entries: new Map([[name, { store }]]),
    transport: {
      start(next) { handlers = next; return () => {}; },
      async fetchState(clientId) { return { ...rooms.state(room, clientId), conn: 'connected-tab' }; },
      async send(clientId, sentFrame) {
        const { blockeditorGeneration, ...frame } = sentFrame;
        const result = rooms.apply(room, clientId, frame);
        sent.push({ frame, result });
        if (result.seq) handlers.frame({ ...result, from: clientId, n: frame.n });
        return { status: result.error ? 409 : 200, body: result };
      },
    },
  });
  store.onLocal((ops) => lane.local(name, ops, store.mark));
  try {
    lane.start();
    handlers.open({ clientId: 'installed-client' });
    await jest.advanceTimersByTimeAsync(0);
    const token = rooms.reservePageReplacement('doc', { nodeId: 1, html: html(restored) });
    rooms.commitPage(token);
    rooms.releasePage(token);
    handlers.state(rooms.state(room, 'installed-client'));
    store.handle.set(['blocks', 'p', 'c'], 'after Restore');
    await jest.advanceTimersByTimeAsync(50);
    expect(sent).toHaveLength(1);
    expect(sent[0].frame.blockeditorGeneration).toBeUndefined();
    expect(sent[0].result.seq).toBe(2);
    expect(room.stores.get(name).value.blocks.p.c).toBe('after Restore');
    expect(store.pending).toEqual([]);
  } finally {
    lane.stop();
    jest.useRealTimers();
  }
});

/**
 * @jest-environment jsdom
 */
import { SyncStream } from '../../src/sync/stream.js';

let sources;

class Source extends EventTarget {
  constructor(url) { super(); this.url = url; this.readyState = 0; this.close = () => {}; sources.push(this); }
}

const cursors = stream => {
  const seen = [];
  stream.addEventListener('cursor', event => seen.push(JSON.parse(event.data)));
  return seen;
};

beforeEach(() => {
  sources = [];
  delete global.SharedWorker;
  global.EventSource = Source;
});

afterEach(() => {
  delete global.EventSource;
  delete global.SharedWorker;
});

test('a reconnect with no cursor from the host asks for a repair', () => {
  const stream = new SyncStream('http://localhost/_/sync?lane=saved', { lane: 'saved' });
  const seen = cursors(stream);

  sources[0].onopen();
  expect(seen).toHaveLength(0);

  sources[0].onerror();
  sources[0].onopen();
  expect(seen).toEqual([{ resync: true, startup: false }]);
  stream.close();
});

test('a host that sends cursors decides the repair itself', () => {
  const stream = new SyncStream('http://localhost/_/sync?lane=saved', { lane: 'saved' });
  const seen = cursors(stream);

  sources[0].onopen();
  sources[0].dispatchEvent(new MessageEvent('cursor', { data: '{"seq":3}' }));
  sources[0].onerror();
  sources[0].onopen();
  expect(seen).toEqual([{ seq: 3 }]);
  stream.close();
});

test('the first open asks for nothing', () => {
  const stream = new SyncStream('http://localhost/_/sync?lane=saved', { lane: 'saved' });
  const seen = cursors(stream);

  sources[0].onopen();
  expect(sources).toHaveLength(1);
  expect(seen).toHaveLength(0);
  stream.close();
});

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRooms, liveTags } from '../../../src/server/rooms/index.js';
import { serializeLive, textHash } from '../../../src/server/rooms/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/large-y-page.json', import.meta.url), 'utf8'));
const seed = gunzipSync(Buffer.from(fixture.seedGzip, 'base64')).toString('base64');
const valueOf = (updates = {}) => ({ v: 1, g: 0, y: { seed, ...updates } });
const htmlOf = (value, at) => `<!doctype html><html><head><title>Yjs fixture</title></head><body><article data-blockeditor><p>Readable sentinel</p></article><script type="application/json" merge="blockeditor" clay="live"${at ? ` live-at="${at.epoch}:${at.seq}:${at.hash}"` : ''}>${serializeLive(value)}</script><script type="application/json" merge="prefs" clay="live">{"sentinel":17}</script></body></html>`;

test('the real parser and file merge preserve large opaque Yjs updates through a room restart', () => {
  const base = valueOf();
  const html = htmlOf(base);
  expect(Buffer.byteLength(serializeLive(base))).toBeGreaterThan(700000);
  const tags = liveTags(html);
  expect(tags.map((tag) => tag.name)).toEqual(['blockeditor', 'prefs']);
  expect(JSON.parse(tags[0].text)).toEqual(base);

  const rooms = createRooms({ newEpoch: () => 'large-y-page' });
  const room = rooms.open('fixture', html);
  expect(room.stores.size).toBe(2);
  const applied = rooms.apply(room, 'peer', {
    name: 'blockeditor', epoch: room.epoch, n: 1, blockeditorGeneration: room.blockeditorTransition.id,
    ops: [{ op: 'set', path: ['y', 'peer'], value: fixture.peer }],
  });
  expect(applied.seq).toBe(1);
  const at = { epoch: room.epoch, seq: 0, hash: textHash(serializeLive(base)) };
  const capture = htmlOf(valueOf({ file: fixture.file }), at);
  expect(liveTags(capture)[0].at).toEqual(at);
  const written = rooms.fileWritten('fixture', capture);
  expect(written.valueChanged).toBe(true);
  const expected = valueOf({ file: fixture.file, peer: fixture.peer });
  expect(room.stores.get('blockeditor').value).toEqual(expected);
  expect(room.stores.get('prefs').value).toEqual({ sentinel: 17 });

  const restarted = createRooms().open('fixture', htmlOf(room.stores.get('blockeditor').value));
  expect(restarted.stores.size).toBe(2);
  expect(restarted.stores.get('blockeditor').value).toEqual(expected);
  expect(restarted.stores.get('prefs').value).toEqual({ sentinel: 17 });
});

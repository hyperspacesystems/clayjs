import { checkPageWriteFormat, PageFormatError } from '../../../src/server/rooms/index.js';
import { createRooms } from '../../../src/server/rooms/index.js';
import { serializeLive } from '../../../src/server/rooms/index.js';

const value = { v: 1, g: 0, y: { seed: 'opaque' } };
const tag = (data, name = 'blockeditor') => `<script type="application/json" merge="${name}" clay="live">${serializeLive(data)}</script>`;
const currentHtml = `<article>before</article>${tag(value)}`;
const check = (html, extra = {}) => checkPageWriteFormat({ currentHtml, html, ...extra });

test('surrounding HTML edits preserve a converted page without requiring client metadata', () => {
  expect(() => check(`<article>after</article>${tag(value)}`)).not.toThrow();
  expect(() => check(currentHtml)).not.toThrow();
});

test.each([
  ['missing page', '<article>after</article>'],
  ['absent capture', undefined],
  ['inert page', `<template>${tag(value)}</template>`],
  ['external script', tag(value).replace('<script ', '<script src="page.json" ')],
  ['non-live tag', tag(value).replace('clay="live"', '')],
])('%s is admitted as an ordinary outside edit', (_label, html) => {
  expect(() => check(html)).not.toThrow();
});

test.each([
  ['hybrid value', tag({ blocks: {} })],
  ['mixed value', tag({ ...value, blocks: {} })],
  ['deleted envelope', tag({ y: value.y })],
  ['new version', tag({ ...value, v: 2 })],
  ['non-string update', tag({ ...value, y: { seed: {} } })],
  ['incomplete multipart group', tag({ v: 1, y: { 'u.0.2': 'first' } })],
  ['conflicting multipart count', tag({ v: 1, y: { 'u.0.2': 'first', 'u.1.3': 'second' } })],
  ['whole and multipart alias', tag({ v: 1, y: { u: 'whole', 'u.0.1': 'part' } })],
  ['duplicate page', tag(value) + tag(value)],
  ['page shard', tag(value) + tag({ blocks: {} }, 'blockeditor.1')],
  ['renamed page', tag(value, 'blockeditor.1')],
  ['ephemeral page', tag(value).replace('clay="live"', 'clay="live ephemeral"')],
  ['malformed JSON', tag(value).replace(serializeLive(value), '{broken')],
])('%s refuses as a page format conflict', (_label, html) => {
  expect(() => check(html)).toThrow(PageFormatError);
  try {
    check(html);
  } catch (error) {
    expect(error).toMatchObject({ code: 'blockeditor-format', statusCode: 409 });
  }
});

test('complete multipart captures, compaction and optional generation fields remain legal', () => {
  for (const next of [
    { v: 1, y: { 'm.0.2': 'first', 'm.1.2': 'second' } },
    { v: 1, g: 'opaque', y: { compacted: 'different update' } },
    { v: 1, y: {} },
    { v: 1, y: { large: 'x'.repeat(1024 * 1024 + 1) } },
  ]) expect(() => check(tag(next))).not.toThrow();
});

test('the same parser recognizes encoded page names and JSON content types', () => {
  const encoded = tag(value).replace('merge="blockeditor"', 'merge="p&#97;ge"').replace('application/json', 'application/vnd.page+json');
  expect(() => check(encoded)).not.toThrow();
  expect(() => check('<article>gone</article>', { currentHtml: encoded })).not.toThrow();
});

test('converted room metadata also protects a missing or incompatible disk capture without mutation', () => {
  const rooms = createRooms();
  const room = rooms.open('doc', currentHtml, { nodeId: 1 });
  const before = JSON.stringify([rooms.state(room, 'peer'), rooms.used()]);
  for (const disk of ['', tag({ blocks: {} }), tag({ counter: 1 })]) {
    expect(() => check(tag({ blocks: {} }), { currentHtml: disk, room })).toThrow(PageFormatError);
    expect(() => check(tag(value), { currentHtml: disk, room })).not.toThrow();
  }
  expect(JSON.stringify([rooms.state(room, 'peer'), rooms.used()])).toBe(before);
});

test('the format guard leaves hybrid, generic and new documents to their separate admission rules', () => {
  for (const currentHtml of [undefined, '', tag({ blocks: {} }), tag({ count: 1 }), tag({ v: 7, y: 4 })]) {
    expect(() => check('<article>changed</article>', { currentHtml })).not.toThrow();
  }
});

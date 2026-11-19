import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { inspectPage, isYPageValue, pageBaseline } from '../../../src/server/rooms/index.js';
import { liveTags } from '../../../src/server/rooms/index.js';
import { serializeLive } from '../../../src/server/rooms/index.js';

const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/page-conversion-inputs.json', import.meta.url), 'utf8'));
const hybrid = { blocks: { p: { t: 'paragraph', pos: 'A', c: 'AAAA' } } };
const yjs = { v: 1, g: 0, y: { seed: 'opaque update' } };
const tag = (name, value, attrs = '') => `<script type="application/json" merge="${name}" clay="live" ${attrs}>${serializeLive(value)}</script>`;
const page = (...tags) => `<!doctype html><html><body>${tags.join('')}</body></html>`;

describe('page inspection', () => {
  test('skips parsing a large ordinary document without a merge attribute', () => {
    const source = `<main>${'ordinary content'.repeat(10000)}</main>`;
    const html = { toString: jest.fn(() => source), get type() { throw new Error('HTML parser called'); } };
    expect(inspectPage(html)).toEqual({ kind: 'none', tags: [] });
    expect(html.toString).toHaveBeenCalledTimes(1);
  });
  test.each(fixtures)('retains raw inputs and DOM order for $name', ({ tags }) => {
    expect(inspectPage(page(...tags.map(([name, value]) => tag(name, value))))).toEqual({ kind: 'hybrid', tags });
  });

  test('uses the live parser for encoded attributes, MIME types and relaxed JSON', () => {
    const html = page('<script type="application/ld&#43;json; charset=utf-8" merge="block&#101;ditor" clay="li&#118;e">{blocks: {p: {t: \'paragraph\', pos: \'A\', c: \'AAAA\',}}, /* ok */}</script>');
    expect(inspectPage(html)).toEqual({ kind: 'hybrid', tags: [['blockeditor', hybrid]] });
  });

  test('ignores non-live, external, inert, non-JSON and unrelated tags', () => {
    const html = page(
      `<template>${tag('blockeditor', hybrid)}</template>`,
      `<noscript>${tag('blockeditor', hybrid)}</noscript>`,
      tag('blockeditor', hybrid, 'src="data.json"'),
      '<script merge="blockeditor" type="application/json">{}</script>',
      '<script merge="blockeditor" clay="live" type="text/plain">{}</script>',
      tag('page.extra', hybrid), tag('page.-1', hybrid), tag('counter', { n: 1 }),
    );
    expect(inspectPage(html)).toEqual({ kind: 'none', tags: [] });
  });

  test('detects duplicate names that ordinary live parsing deliberately skips', () => {
    const html = page(tag('blockeditor', hybrid), tag('counter', { n: 1 }), tag('blockeditor', yjs));
    expect(liveTags(html).map(({ name }) => name)).toEqual(['counter']);
    expect(liveTags(html, { includeDuplicates: true }).map(({ name }) => name)).toEqual(['blockeditor', 'counter', 'blockeditor']);
    expect(inspectPage(html)).toEqual({ kind: 'invalid', reason: 'duplicate-tag', tags: [] });
  });

  test('does not silently drop a malformed or ephemeral page tag', () => {
    expect(inspectPage(page(tag('blockeditor', hybrid), '<script type="application/json" merge="blockeditor.1" clay="live">{broken</script>'))).toMatchObject({ kind: 'invalid', reason: 'invalid-json' });
    expect(inspectPage(page('<script type="application/json" merge="blockeditor" clay="live ephemeral">{"blocks":{}}</script>'))).toMatchObject({ kind: 'invalid', reason: 'ephemeral-tag' });
  });

  test.each([{}, [], 17, { title: 'generic' }, { blocks: [], extra: true }].map((value) => [value]))('describes unrelated store values without claiming page content: %j', (value) => {
    expect(inspectPage(page(tag('blockeditor', value)))).toEqual({ kind: 'other', tags: [['blockeditor', value]] });
  });

  test('accepts one page envelope and preserves its opaque bytes', () => {
    expect(inspectPage(page(tag('blockeditor', yjs), tag('counter', { n: 1 })))).toEqual({ kind: 'yjs', tags: [['blockeditor', yjs]] });
  });

  test.each([
    [tag('blockeditor.1', yjs)],
    [tag('blockeditor', yjs), tag('blockeditor.1', hybrid)],
    [tag('blockeditor', yjs), tag('blockeditor.1', yjs)],
    [tag('blockeditor', { ...yjs, blocks: {} })],
    [tag('blockeditor', { ...yjs, deleted: {} })],
    [tag('blockeditor', { ...yjs, extra: true })],
    [tag('blockeditor', { v: 1 })],
  ])('reports an ambiguous or malformed Yjs capture', (...tags) => {
    expect(inspectPage(page(...tags))).toMatchObject({ kind: 'invalid', reason: 'invalid-yjs' });
  });
});

describe('opaque Yjs structure', () => {
  test('does not add seed, g or binary-decoding requirements', () => {
    expect(isYPageValue({ v: 1, y: {} })).toBe(true);
    expect(isYPageValue({ v: 1, g: null, y: { compacted: 'opaque' } })).toBe(true);
  });

  test('accepts complete groups and permits partial groups only when explicitly requested', () => {
    const partial = { v: 1, y: { 'seed.0.2': 'first' } };
    expect(isYPageValue(partial)).toBe(false);
    expect(isYPageValue(partial, { complete: false })).toBe(true);
    expect(isYPageValue({ v: 1, y: { ...partial.y, 'seed.1.2': 'second' } })).toBe(true);
    expect(inspectPage(page(tag('blockeditor', partial))).kind).toBe('invalid');
  });

  test.each([
    null, [], { v: 2, y: {} }, { v: 1, y: [] }, { v: 1, y: { seed: 5 } },
    { v: 1, y: { 'seed.2.2': 'x' } },
    { v: 1, y: { 'seed.0.0': 'x' } },
    { v: 1, y: { 'seed.0.9007199254740992': 'x' } },
    { v: 1, y: { 'seed.0.2': 'x', 'seed.1.3': 'x' } },
    { v: 1, y: { 'seed.0.1': 'x', 'seed.00.1': 'x' } },
    { v: 1, y: { seed: 'x', 'seed.0.1': 'x' } },
  ].map((value) => [value]))('rejects invalid structure even between frames: %j', (value) => {
    expect(isYPageValue(value)).toBe(false);
    expect(isYPageValue(value, { complete: false })).toBe(false);
  });
});

describe('exact conversion baseline', () => {
  test('matches the independently executed ClayJS baseline vector', () => {
    expect(pageBaseline(fixtures[0].tags)).toBe('31c0ff759ab43beb1b5cc06df456d3ac2d422c2200acb52b16e3e5bffae5f0ec');
  });

  test('sorts integer-shaped object keys lexicographically, not as JSON.stringify does', () => {
    const tags = [['blockeditor', { blocks: { '2': {}, '10': {} } }]];
    const text = '[["blockeditor",{"blocks":{"10":{},"2":{}}}]]';
    expect(pageBaseline(tags)).toBe(createHash('sha256').update(text).digest('hex'));
    expect(pageBaseline(tags)).not.toBe(createHash('sha256').update(JSON.stringify(tags)).digest('hex'));
  });

  test('ignores object key order but retains tag order, names, raw blocks and tombstones', () => {
    const tags = fixtures[2].tags;
    const reorder = (value) => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reorder(value[key])])) : value;
    expect(pageBaseline(reorder(tags))).toBe(pageBaseline(tags));
    const changed = JSON.parse(JSON.stringify(tags));
    changed[0][1].blocks.hidden.raw['10'] = 'changed';
    expect(pageBaseline(changed)).not.toBe(pageBaseline(tags));
    changed[0][1].blocks.hidden.raw['10'] = 'preserved';
    changed[0][1].deleted.absent = true;
    expect(pageBaseline(changed)).not.toBe(pageBaseline(tags));
    const shards = fixtures[1].tags;
    expect(pageBaseline([...shards].reverse())).not.toBe(pageBaseline(shards));
    expect(pageBaseline([['blockeditor.1', hybrid]])).not.toBe(pageBaseline([['blockeditor', hybrid]]));
  });

  test.each([
    [], null, [['counter', hybrid]], [['blockeditor', hybrid], ['blockeditor', hybrid]],
    [['blockeditor', yjs]], [['blockeditor', { blocks: [] }]], [['blockeditor', { blocks: {}, extra: true }]],
    [['blockeditor', { blocks: {}, deleted: [] }]], [['blockeditor', { blocks: {}, deleted: undefined }]],
  ].map((tags) => [tags]))('refuses a missing, ambiguous or unsupported source: %j', (tags) => {
    expect(() => pageBaseline(tags)).toThrow(TypeError);
  });
});

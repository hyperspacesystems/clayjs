import { liveTags } from '../../../src/server/rooms/index.js';

// liveTags must find what a browser finds: the server seeds rooms and merges
// outside writes from these tags, and the browser's live plugin reads the same
// tags from the DOM. Each case is a shape an outside writer (code editor,
// ai-edit, upload) can produce.
const page = (body, head = '') => `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
const live = (name, json, attrs = '') => `<script type="application/json" merge="${name}" clay="live"${attrs}>${json}</script>`;
const found = (html) => liveTags(html).map((t) => [t.name, t.text]);

describe('liveTags reads tags as a browser does', () => {
  test.each([
    ['in head', page('<p>x</p>', live('cfg', '{"a":1}')), [['cfg', '{"a":1}']]],
    ['uppercase markup', page('<SCRIPT TYPE="application/json" MERGE="up" CLAY="live">{"u":1}</SCRIPT>'), [['up', '{"u":1}']]],
    ['single and no quotes', page(`<script type='application/json' merge='sq' clay='live'>{}</script><script type=application/json merge=uq clay=live>{}</script>`), [['sq', '{}'], ['uq', '{}']]],
    ['entities stay raw', page(live('g', '{"a":"&lt;b&gt; &amp;"}')), [['g', '{"a":"&lt;b&gt; &amp;"}']]],
    ['a JSON string holding a commented script', page(live('g', '{"a":"<!--<script>x</script>-->"}')), [['g', '{"a":"<!--<script>x</script>-->"}']]],
    ['one block per line', page(live('blockeditor', '{"blocks":{\n"p":{"c":"one"}\n},\n"deleted":{}}', ' live-format="lines"')), [['blockeditor', '{"blocks":{\n"p":{"c":"one"}\n},\n"deleted":{}}']]],
    ['in a table', page(`<table><tr>${live('t', '{"t":1}')}<td>x</td></tr></table>`), [['t', '{"t":1}']]],
    ['after </html>', `<!DOCTYPE html><html><head></head><body></body></html>${live('late', '{}')}`, [['late', '{}']]],
    ['inside <template>, nested too', page(`<template><div><template>${live('deep', '{}')}</template></div>${live('hidden', '{}')}</template>${live('top', '{}')}`), [['top', '{}']]],
    ['inside <noscript>', page(`<noscript>${live('n', '{}')}</noscript>`), []],
    ['inside <iframe>, beside a real tag of the same name', page(`<iframe>${live('i', '{}')}</iframe>${live('i', '{"r":1}')}`), [['i', '{"r":1}']]],
    ['inside <textarea>', page(`<textarea>${live('ta', '{}')}</textarea>${live('after', '{}')}`), [['after', '{}']]],
    ['inside <plaintext>', page(`<plaintext>${live('p', '{}')}`), []],
    ['in a comment', page(`<!-- ${live('c', '{}')} -->${live('real', '{}')}`), [['real', '{}']]],
    ['a name used twice', page(live('dup', '{"a":1}') + live('dup', '{"a":2}') + live('ok', '{}')), [['ok', '{}']]],
  ])('%s', (_, html, expected) => {
    expect(found(html)).toEqual(expected);
  });
});

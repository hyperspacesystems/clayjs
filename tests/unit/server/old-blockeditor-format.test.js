import { oldBlockeditorFormat, oldFormatRefusal } from '../../../src/server/rooms/index.js';

const tag = (name, value) => `<script type="application/json" merge="${name}" clay="live">${JSON.stringify(value)}</script>`;
const doc = (...parts) => `<!doctype html><html><body>${parts.join('')}</body></html>`;
const Y = { v: 1, y: {} };

describe('oldBlockeditorFormat', () => {
  test('an old live tag holding a Yjs envelope is the old format', () => {
    expect(oldBlockeditorFormat(doc(tag('page', Y), '<article class="page" data-page data-rev="r1"></article>'))).toBe(true);
    expect(oldBlockeditorFormat(doc(tag('page.2', { v: 1 })))).toBe(true);
    expect(oldBlockeditorFormat(doc(tag('page', { y: {} })))).toBe(true);
  });

  test("an author's own store named page, a bare data-page article and the new format are not", () => {
    expect(oldBlockeditorFormat(doc(tag('page', { current: 3 })))).toBe(false);
    expect(oldBlockeditorFormat(doc('<article data-page="2">Chapter two</article>'))).toBe(false);
    expect(oldBlockeditorFormat(doc(tag('blockeditor', Y), '<article class="blockeditor" data-blockeditor data-rev="r1"></article>'))).toBe(false);
    expect(oldBlockeditorFormat(doc(tag('pages', Y)))).toBe(false);
    expect(oldBlockeditorFormat('<p>no tags</p>')).toBe(false);
    expect(oldBlockeditorFormat(null)).toBe(false);
  });

  test('the refusal is a 409 the hosts already know how to answer', () => {
    const error = oldFormatRefusal();
    expect(error).toMatchObject({ statusCode: 409, code: 'blockeditor-old-format' });
    expect(error.message).toBe('This document now uses the new Block editor format, so this change was not saved. Copy any text you need from this tab, then reload.');
  });
});

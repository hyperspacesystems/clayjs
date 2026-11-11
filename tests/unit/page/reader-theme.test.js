import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { PAGE_EDITOR_CSS } from '../../../src/page/editor.js';

const themeNames = ['light-1', 'light-2', 'light-3', 'light-4'];
const content = readFileSync(new URL('../../../src/blockeditor/themes/content.css', import.meta.url), 'utf8');
const theme = (name) => readFileSync(new URL(`../../../src/blockeditor/themes/${name === 'light-1' ? 'light-1.source' : name}.css`, import.meta.url), 'utf8');
const withoutImports = (css) => css.replace(/^@import .*;\s*$/gm, '');
const withoutLayer = (css) => css.replace(/^\s*@layer blockeditor \{\s*/, '').replace(/\}\s*$/, '');
const oldEditorCss = PAGE_EDITOR_CSS
  .replaceAll(':where(article[data-blockeditor], .blockeditor-editor)', '.blockeditor-editor')
  .replaceAll(':where(article[data-blockeditor], .blockeditor-shell)', ':where(.blockeditor-shell)')
  .replaceAll(':is(article[data-blockeditor], .blockeditor-shell)', '.blockeditor-shell');
const addCss = (doc, css) => {
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.appendChild(style);
};
const editorHtml = '<!doctype html><html><head></head><body><div class="blockeditor-shell"><div class="blockeditor-editor"><h1>Title</h1><h2>Section</h2><p>Text <code>code</code></p><div class="blockeditor-li" data-kind="check" data-checked="true">Task</div><aside class="blockeditor-callout">Note</aside><figure class="blockeditor-chart"><figcaption>Chart</figcaption></figure></div></div></body></html>';
const readerHtml = '<!doctype html><html><head><link rel="stylesheet" href="https://clayjs.com/v1/src/blockeditor/themes/light-1.css"></head><body><article class="blockeditor" clay="freeze" data-blockeditor="1" data-rev="saved"><h1 data-id="title">Title</h1><h2 data-id="section">Section</h2><p data-id="text">Text <code>code</code></p><ul><li data-id="task"><input type="checkbox" checked disabled>Task</li></ul><aside class="blockeditor-callout">Note</aside><pre><code>code</code></pre><table><tr><th>Label</th><td>Value</td></tr></table><figure data-type="chart"><svg></svg><figcaption>Chart</figcaption></figure><blockquote>Quote</blockquote></article></body></html>';

const editorStyles = (base, css) => {
  const dom = new JSDOM(editorHtml);
  const doc = dom.window.document;
  addCss(doc, withoutLayer(base) + '\n' + css);
  const shell = doc.querySelector('.blockeditor-shell');
  const h1 = doc.querySelector('h1');
  const h2 = doc.querySelector('h2');
  const li = doc.querySelector('.blockeditor-li');
  const code = doc.querySelector('code');
  const sample = {
    background: dom.window.getComputedStyle(shell).getPropertyValue('--blockeditor-bg'),
    font: dom.window.getComputedStyle(shell).getPropertyValue('--blockeditor-font'),
    headingSize: dom.window.getComputedStyle(h1).fontSize,
    headingMargin: dom.window.getComputedStyle(h1).marginBottom,
    sectionMargin: dom.window.getComputedStyle(h2).marginTop,
    sectionLine: dom.window.getComputedStyle(h2).lineHeight,
    listMargin: dom.window.getComputedStyle(li).marginTop,
    codeSize: dom.window.getComputedStyle(code).fontSize,
  };
  dom.window.close();
  return sample;
};

test.each(themeNames)('%s styles the saved article and preserves editor content styles', (name) => {
  const css = theme(name);
  expect(css).toContain('@import url("./content.css")');
  const dom = new JSDOM(readerHtml.replace('light-1.css', `${name}.css`));
  const doc = dom.window.document;
  addCss(doc, withoutLayer(content) + '\n' + withoutImports(css));
  const article = doc.querySelector('article[data-blockeditor]');
  expect(doc.querySelector('.blockeditor-shell')).toBeNull();
  expect(doc.querySelector(':where(article[data-blockeditor], .blockeditor-shell)')).toBe(article);
  expect(dom.window.getComputedStyle(article).getPropertyValue('--blockeditor-bg').trim()).not.toBe('');
  expect(dom.window.getComputedStyle(article).getPropertyValue('--blockeditor-font').trim()).not.toBe('');
  expect(dom.window.getComputedStyle(article).getPropertyValue('--blockeditor-check-size').trim()).not.toBe('');
  for (const selector of ['article[data-blockeditor] > h1', 'article[data-blockeditor] li > input[type="checkbox"]', 'article[data-blockeditor] .blockeditor-callout', 'article[data-blockeditor] pre code', 'article[data-blockeditor] table', 'article[data-blockeditor] figure[data-type="chart"]', 'article[data-blockeditor] blockquote']) {
    expect(doc.querySelector(selector)).not.toBeNull();
    expect(withoutLayer(content) + css).toContain(selector);
  }
  expect(dom.window.getComputedStyle(article.querySelector('h1')).fontSize).not.toBe('');
  expect(dom.window.getComputedStyle(article.querySelector('th')).padding).not.toBe('');
  dom.window.close();

  const oldSelectors = withoutImports(css)
    .replaceAll(':is(article[data-blockeditor], .blockeditor-shell .blockeditor-editor)', '.blockeditor-shell .blockeditor-editor')
    .replaceAll(':is(article[data-blockeditor], .blockeditor-shell) .blockeditor-li', '.blockeditor-shell .blockeditor-li')
    .replaceAll(':where(article[data-blockeditor], .blockeditor-shell)', '.blockeditor-shell');
  expect(editorStyles(oldEditorCss, oldSelectors)).toEqual(editorStyles(PAGE_EDITOR_CSS, withoutLayer(content) + '\n' + withoutImports(css)));
});

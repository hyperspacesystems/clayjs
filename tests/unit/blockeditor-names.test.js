import fs from 'node:fs';
import path from 'node:path';

// 1.24.0 renamed the block editor's public names from `page` to `blockeditor`, with no
// backward compatibility. Any old name left in src is a host or a saved file the runtime
// no longer understands, so this test fails on one.
const ROOT = path.resolve(process.cwd(), 'src');
const SKIP = [/^vendor\//, /^ui\/bevel/, /^ui\/page-(colour|scheme)\.js$/, /^core\/page-data/];
const FILE_NAME = /\bpage-[\w-]*\.(?:m?js|cjs|json|html|css)\b/g;
const OLD = [
  /--page-/,
  /(?<![\w/\\-])page-(?!break|url\b|lifetime|load\b|author|scheme|colour|color|data\b|data-write)[a-z0-9]/,
  /\bdata-page(?![\w-]size)\b/,
  /\bdata-clay-page-/,
  /\bmerge[\^*$|~]?=\\?["']?page\b/,
  /\bclay-page-format\b/,
  /@layer page\b/,
  /\b(no|bad|invalid|stale|room|unknown|missing|unsupported|incomplete|ambiguous)-page\b/,
  /\bdrafts-page-/,
  /\bX-Clay-Page-Format\b/i,
  /\bPage-(Write|Conversion|If-Match|Revision)\b/,
  /\/page-state(?![\w-])/,
  /\/src\/page\/themes\//,
  /\bclay:page\b/,
  /\bpage(Generation|State|Record|Write|FormatFloor|Conversion|Transition)\b/,
  /\bplugins=page\b/,
  /\bclay\.page\b(?!\.author)/,
];
// The one place that must still name the old format: the detector hosts refuse it with.
const ALLOWED = new Set(['server/rooms/page-admission.js:40']);

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? files(full) : /\.(m?js|cjs|css|html)$/.test(entry.name) ? [full] : [];
});

export function oldNames(text, where = '') {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    const at = `${where}:${i + 1}`;
    if (ALLOWED.has(at)) return;
    const bare = line.replace(FILE_NAME, '');
    if (OLD.some((pattern) => pattern.test(bare))) hits.push(`${at}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

describe('no old block editor name is left in src', () => {
  test('the check sees an old name (it can fail)', () => {
    expect(oldNames('<article class="page" data-page data-rev="r1">')).toHaveLength(1);
    expect(oldNames('<script merge="page" clay="live">')).toHaveLength(1);
    expect(oldNames("import x from './page-state.js';")).toHaveLength(0);
  });

  test('src holds none', () => {
    const hits = files(ROOT).flatMap((file) => {
      const rel = path.relative(ROOT, file);
      return SKIP.some((skip) => skip.test(rel)) ? [] : oldNames(fs.readFileSync(file, 'utf8'), rel);
    });
    expect(hits).toEqual([]);
  });
});

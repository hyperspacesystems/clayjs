// Rebuild src/vendor/exceljs.vendor.js from the exceljs 4.4.0 package on npm.
//
//   node scripts/build-exceljs-vendor.mjs
//
// The sheet's .xlsx import and export, loaded only when someone imports or downloads a
// .xlsx file. It is not a dependency in package.json: its 190 dependencies are already
// bundled inside its browser build, so this script fetches that one tarball, checks it
// against the integrity npm published, and wraps the bundle as an ES module.
//
// Committed, like every other file in src/vendor/, because src/ is what npm publishes and
// what clayjs.com serves.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '4.4.0';
const INTEGRITY = 'sha512-XctvKaEMaj1Ii9oDOqbW/6e1gXknSY4g/aLCDicOXqBE4M0nRWkUu0PTp++UPNzoFY12BNHMfs/VadKIS6llvg==';
const OUT = join(ROOT, 'src', 'vendor', 'exceljs.vendor.js');

const work = mkdtempSync(join(tmpdir(), 'exceljs-vendor-'));
try {
  const name = execFileSync('npm', ['pack', `exceljs@${VERSION}`, '--silent', '--pack-destination', work], { encoding: 'utf8' }).trim();
  const tarball = join(work, name);
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
  if (integrity !== INTEGRITY) throw new Error(`exceljs ${VERSION} tarball integrity ${integrity} is not the pinned ${INTEGRITY}`);
  execFileSync('tar', ['-xzf', tarball, '-C', work, 'package/dist/exceljs.bare.min.js', 'package/LICENSE']);
  const bundle = readFileSync(join(work, 'package/dist/exceljs.bare.min.js'), 'utf8').replace(/\n\/\/# sourceMappingURL=.*\s*$/, '');
  const license = readFileSync(join(work, 'package/LICENSE'), 'utf8').trim();
  // The bundle is UMD: given a CommonJS `module`, it puts the library on module.exports. Its
  // browserify loader only asks `typeof require`, so a bound undefined `require` keeps a bundler
  // from turning that into a runtime require() that throws in the browser.
  const out =
    `/* ExcelJS ${VERSION} (MIT), the browser build without polyfills, for clayjs's sheet.\n` +
    `   https://github.com/exceljs/exceljs, regenerate with node scripts/build-exceljs-vendor.mjs\n\n` +
    license.replace(/\*\//g, '* /') + ' */\n' +
    'const module = { exports: {} };\nconst exports = module.exports;\nconst require = undefined;\n' +
    bundle.trim() + '\n' +
    'export default module.exports;\n';
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT} (${out.length} bytes)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

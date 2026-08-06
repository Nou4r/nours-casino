#!/usr/bin/env node
/**
 * Builds `www/` — the directory Capacitor copies into the native app bundles.
 *
 * There is no bundler, transpiler or minifier here on purpose. The app is pure
 * ES modules + Canvas 2D and must keep running when the repo root is served
 * directly over plain HTTP with no Capacitor present (`npm run serve`). So this
 * script is a copy, nothing more: whatever ships natively is byte-identical to
 * what a browser loads from the root. That property is the whole reason a bug
 * can be reproduced in a desktop browser and trusted to be the same bug on
 * device.
 *
 * `www/` is generated and gitignored. Never hand-edit it — the next build wipes
 * it without warning. The repo root is the source of truth.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'www');

/**
 * What ships. Local fonts are required because the source document preloads and
 * references them directly; allowing a missing directory would produce failed
 * requests and a visually inconsistent native bundle.
 */
const SOURCES = [
  { path: 'index.html', optional: false },
  { path: 'styles.css', optional: false },
  { path: 'css', optional: false },
  { path: 'js', optional: false },
  { path: 'assets', optional: false },
  { path: 'fonts', optional: false },
];

/**
 * Belt-and-braces deny list. The SOURCES list above already excludes all of
 * this by omission, so today this guard matches nothing. It exists because the
 * failure mode it prevents is silent and expensive: the day someone adds a
 * broad entry to SOURCES, this is what stops `node_modules/`, the native
 * platform trees or `cookies.txt` from being copied into a shipped app bundle.
 */
const DENY_NAMES = new Set([
  'node_modules', 'www', 'android', 'ios', 'resources', '.git', 'scripts',
  'cookies.txt',
]);
const DENY_EXTENSIONS = ['.bat', '.md'];

/**
 * Should this directory entry be excluded from the copy?
 *
 * @param {string} name Bare entry name (not a path).
 * @returns {boolean} True when the entry must never reach `www/`.
 */
function isDenied(name) {
  if (DENY_NAMES.has(name)) return true;
  const lower = name.toLowerCase();
  return DENY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

let fileCount = 0;
let byteCount = 0;

/**
 * Recursively copies a file or directory from the repo root into `www/`,
 * preserving relative layout and skipping denied entries.
 *
 * @param {string} rel Path relative to the repo root.
 * @returns {void}
 */
function copyInto(rel) {
  const from = join(ROOT, rel);
  const to = join(OUT, rel);
  const info = statSync(from);

  if (info.isDirectory()) {
    mkdirSync(to, { recursive: true });
    // Sorted so a build is reproducible entry-for-entry, not just in aggregate.
    for (const name of readdirSync(from).sort()) {
      if (isDenied(name)) continue;
      copyInto(join(rel, name));
    }
    return;
  }

  if (!info.isFile()) return; // sockets, symlink loops, device nodes — not shippable
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  fileCount += 1;
  byteCount += info.size;
}

/**
 * Verifies that the packaged copy keeps the same self-hosted font contract as
 * the browser source. Fails loudly rather than shipping a font-less bundle or
 * reintroducing a render-blocking third-party stylesheet.
 *
 * @returns {void}
 */
function verifyLocalFonts() {
  const indexPath = join(OUT, 'index.html');
  const shipped = readFileSync(indexPath, 'utf8');
  const problems = [];
  if (/fonts\.(googleapis|gstatic)\.com/.test(shipped)) problems.push('a CDN font reference survived');
  if (!/<link\b[^>]*href="css\/fonts\.css"/.test(shipped)) problems.push('css/fonts.css is not linked');
  if (!existsSync(join(OUT, 'css', 'fonts.css'))) problems.push('css/fonts.css was not copied');
  for (const f of ['inter-latin.woff2', 'roboto-mono-latin.woff2']) {
    if (!existsSync(join(OUT, 'fonts', f))) problems.push(`fonts/${f} is missing`);
  }
  if (problems.length) throw new Error(`packaged fonts are broken — ${problems.join('; ')}`);
  console.log('build-www: self-hosted fonts verified');
}

/**
 * Verifies the no-flash appearance contract in the packaged web directory.
 * The classic bootstrap must be external (CSP-safe), parser-blocking and placed
 * before the first stylesheet so a persisted OLED choice wins first paint.
 *
 * @returns {void}
 */
function verifyThemeBootstrap() {
  const indexPath = join(OUT, 'index.html');
  const shipped = readFileSync(indexPath, 'utf8');
  const bootstrapAt = shipped.indexOf('<script src="js/theme-bootstrap.js"></script>');
  const stylesheetAt = shipped.indexOf('<link rel="stylesheet"');
  const problems = [];

  if (bootstrapAt < 0) problems.push('js/theme-bootstrap.js is not linked');
  if (stylesheetAt >= 0 && bootstrapAt > stylesheetAt) problems.push('theme bootstrap runs after a stylesheet');
  if (!existsSync(join(OUT, 'js', 'theme-bootstrap.js'))) problems.push('js/theme-bootstrap.js was not copied');
  if (!existsSync(join(OUT, 'js', 'theme.js'))) problems.push('js/theme.js was not copied');
  if (!existsSync(join(OUT, 'css', 'themes.css'))) problems.push('css/themes.css was not copied');
  if (!/data-theme="default"/.test(shipped)) problems.push('the root theme fallback is missing');
  if (problems.length) throw new Error(`packaged appearance theme is broken — ${problems.join('; ')}`);
  console.log('build-www: pre-paint appearance bootstrap verified');
}

try {
  // A wipe rather than an overwrite: a stale file left behind by a rename would
  // otherwise ship forever, and `www/` is exactly where nobody looks for it.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const { path, optional } of SOURCES) {
    if (!existsSync(join(ROOT, path))) {
      if (optional) continue;
      throw new Error(`required source missing: ${path}`);
    }
    copyInto(path);
  }

  if (!existsSync(join(OUT, 'index.html'))) {
    throw new Error('www/index.html was not produced — refusing to report success');
  }

  verifyLocalFonts();
  verifyThemeBootstrap();

  const kib = (byteCount / 1024).toFixed(1);
  console.log(`build-www: ${fileCount} files, ${byteCount} bytes (${kib} KiB) -> ${relative(ROOT, OUT)}${sep}`);
} catch (err) {
  console.error(`build-www: FAILED — ${err && err.message ? err.message : err}`);
  process.exit(1);
}

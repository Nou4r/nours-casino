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
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'www');

/**
 * What ships. `optional: true` means "skip silently if absent" — `fonts/` is
 * genuinely optional (the UI falls back to system stacks), so a missing font
 * directory is a valid build, not an error.
 */
const SOURCES = [
  { path: 'index.html', optional: false },
  { path: 'styles.css', optional: false },
  { path: 'css', optional: false },
  { path: 'js', optional: false },
  { path: 'fonts', optional: true },
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
 * Swaps the Google Fonts CDN for the vendored faces in the PACKAGED copy only.
 *
 * The repo root keeps its `fonts.googleapis.com` link, because that is what
 * Cloudflare serves and a CDN is a perfectly good answer on the open web. Inside
 * an APK/IPA it is the wrong answer twice over:
 *
 *   1. A packaged WebView may have no network, so the faces never arrive and the
 *      whole UI silently drops to a system stack.
 *   2. Worse, `<link rel="stylesheet">` is RENDER-BLOCKING. Offline — or behind a
 *      captive portal — that request stalls for the full DNS/connect timeout,
 *      first paint never happens, and because `capacitor.config.js` sets
 *      `launchAutoHide: false` with the splash hide gated on the first painted
 *      frame, the app hangs on the splash screen. Deleting the tag at build time
 *      is the only fix that lands before the document is parsed; doing it from JS
 *      is too late, since script execution itself waits on pending stylesheets.
 *
 * Fails loudly rather than shipping a silently font-less bundle.
 *
 * @returns {void}
 */
function vendorFonts() {
  const indexPath = join(OUT, 'index.html');
  const original = readFileSync(indexPath, 'utf8');

  // Drop the preconnects and the stylesheet, whatever order they appear in.
  let html = original.replace(
    /[ \t]*<link\b[^>]*(?:fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>\r?\n?/g,
    '',
  );
  const strippedCdn = html !== original;

  const alreadyLinked = /<link\b[^>]*href="css\/fonts\.css"/.test(html);
  if (!alreadyLinked) {
    // First stylesheet in the document, so `@font-face` is known before any rule
    // that uses the families.
    const inject = [
      '<link rel="preload" as="font" type="font/woff2" href="fonts/inter-latin.woff2" crossorigin />',
      '<link rel="preload" as="font" type="font/woff2" href="fonts/roboto-mono-latin.woff2" crossorigin />',
      '<link rel="stylesheet" href="css/fonts.css" />',
      '',
    ].join('\n');

    const anchor = /<link\s+rel="stylesheet"/;
    if (!anchor.test(html)) {
      throw new Error('no stylesheet link in index.html to anchor css/fonts.css against');
    }
    html = html.replace(anchor, () => `${inject}<link rel="stylesheet"`);
  }

  if (html !== original) writeFileSync(indexPath, html);

  /* Assert the OUTCOME, not the edit. Checking "did I find the CDN tag?" would
     break the day the root stops using a CDN; checking the shipped file cannot.
     Loud on failure by design — a silently font-less or still-CDN-linked bundle
     is precisely the class of bug that hides until someone runs the app on a
     plane. */
  const shipped = readFileSync(indexPath, 'utf8');
  const problems = [];
  if (/fonts\.(googleapis|gstatic)\.com/.test(shipped)) problems.push('a CDN font reference survived');
  if (!/<link\b[^>]*href="css\/fonts\.css"/.test(shipped)) problems.push('css/fonts.css is not linked');
  if (!existsSync(join(OUT, 'css', 'fonts.css'))) problems.push('css/fonts.css was not copied');
  for (const f of ['inter-latin.woff2', 'roboto-mono-latin.woff2']) {
    if (!existsSync(join(OUT, 'fonts', f))) problems.push(`fonts/${f} is missing`);
  }
  if (problems.length) throw new Error(`packaged fonts are broken — ${problems.join('; ')}`);

  console.log(
    strippedCdn
      ? 'build-www: fonts vendored (CDN links stripped from the packaged index.html)'
      : 'build-www: fonts vendored (root had no CDN links)',
  );
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

  vendorFonts();

  const kib = (byteCount / 1024).toFixed(1);
  console.log(`build-www: ${fileCount} files, ${byteCount} bytes (${kib} KiB) -> ${relative(ROOT, OUT)}${sep}`);
} catch (err) {
  console.error(`build-www: FAILED — ${err && err.message ? err.message : err}`);
  process.exit(1);
}

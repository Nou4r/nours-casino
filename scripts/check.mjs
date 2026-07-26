#!/usr/bin/env node
/**
 * The syntax gate — this project's only automated test.
 *
 * Replaces the bash `for f in js/*.js js/games/*.js …; do node --check "$f"; done`
 * loop from AGENTS.md §1, which silently does nothing on Windows (`cmd`/
 * PowerShell do not expand those globs) and which also misses any directory
 * added under `js/` later. This walks `js/` instead of listing it.
 *
 * Scope warning, unchanged from AGENTS.md §1: `node --check` is a parse check.
 * It will not catch a duplicate `const` across branches, an orphaned method
 * body, or a `ReferenceError` sitting in a code path nothing reached yet.
 * Passing here means "it parses", not "it works".
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = join(ROOT, 'js');

/**
 * Collects every `.js` file under a directory, recursively.
 *
 * @param {string} dir Absolute directory to walk.
 * @returns {string[]} Absolute paths, sorted for stable output ordering.
 */
function collect(dir) {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...collect(full));
    else if (name.endsWith('.js')) found.push(full);
  }
  return found;
}

let files;
try {
  files = collect(JS_DIR);
} catch (err) {
  console.error(`check: cannot read js/ — ${err && err.message ? err.message : err}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error('check: found no .js files under js/ — that is never correct');
  process.exit(1);
}

const failed = [];
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  try {
    // `process.execPath` rather than the bare string 'node': execFileSync does
    // not go through a shell, so on Windows a bare 'node' depends on PATHEXT
    // resolution and can fail even when node is plainly on PATH. This also
    // guarantees every file is checked by the SAME interpreter running this
    // script, not whichever node happens to shadow it.
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const detail = (err && err.stderr ? err.stderr.toString() : String(err)).trimEnd();
    console.error(`FAIL ${rel}`);
    if (detail) console.error(detail);
    failed.push(rel);
  }
}

if (failed.length > 0) {
  console.error(`\ncheck: ${failed.length} of ${files.length} file(s) failed to parse`);
  process.exit(1);
}

/**
 * Guards `capacitor.config.js` against the one edit that breaks everything
 * without saying so.
 *
 * `@capacitor/cli` loads a `.js` config with a bare `await require(file)` and
 * never unwraps `.default`. Since this package is `"type": "module"`, writing
 * the idiomatic `export default { … }` there yields
 * `{ __esModule: true, default: {…} }`, the CLI reads zero keys, and the app
 * builds on Capacitor's defaults — different appId, different WebView origin,
 * and therefore a wiped wallet — with no warning at any point.
 *
 * So we load it exactly the way the CLI does and assert the values actually
 * arrive. The origin triple is pinned by value on purpose: changing it is a
 * decision that must be made deliberately, in the open, by someone who also
 * had to edit this assertion.
 *
 * @returns {string[]} Human-readable problems; empty means the config is sound.
 */
function auditCapacitorConfig() {
  const configPath = join(ROOT, 'capacitor.config.js');
  if (!existsSync(configPath)) return ['capacitor.config.js is missing'];

  let cfg;
  try {
    cfg = createRequire(import.meta.url)(configPath);
  } catch (err) {
    return [`capacitor.config.js does not load via require() — the Capacitor CLI would ` +
      `fail the same way: ${err && err.message ? err.message : err}`];
  }

  if (cfg && cfg.default && cfg.appId === undefined) {
    return ['capacitor.config.js uses `export default`, which @capacitor/cli silently ' +
      'ignores. Use top-level named exports (`export const appId = …`). See the header ' +
      'comment in that file.'];
  }

  const problems = [];
  const expected = { appId: 'com.nourscasino.app', appName: "Nour's Casino", webDir: 'www' };
  for (const [key, want] of Object.entries(expected)) {
    if (cfg[key] !== want) problems.push(`capacitor.config.js: ${key} is ${JSON.stringify(cfg[key])}, expected ${JSON.stringify(want)}`);
  }

  // The WebView origin. See the DO-NOT-CHANGE block in capacitor.config.js.
  const origin = { androidScheme: 'https', iosScheme: 'capacitor', hostname: 'localhost' };
  for (const [key, want] of Object.entries(origin)) {
    const got = cfg.server ? cfg.server[key] : undefined;
    if (got !== want) {
      problems.push(`capacitor.config.js: server.${key} is ${JSON.stringify(got)}, expected ` +
        `${JSON.stringify(want)} — this key defines the localStorage origin; changing it ` +
        'wipes every player wallet');
    }
  }
  return problems;
}

const configProblems = auditCapacitorConfig();
for (const problem of configProblems) console.error(`FAIL ${problem}`);
if (configProblems.length > 0) process.exit(1);

console.log(`check: ${files.length} file(s) OK, capacitor.config.js resolves as the CLI reads it`);

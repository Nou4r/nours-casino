#!/usr/bin/env node
// The only automated gate this project has: parse every module.
// Cross-platform replacement for the `for f in js/*.js; do node --check "$f"; done`
// loop in AGENTS.md, so `npm run check` works in cmd.exe as well as a POSIX shell.
//
// Caveat worth keeping in mind (AGENTS.md §10): --check catches parse errors only.
// It will happily accept a duplicate `const` in different branches or an orphaned
// method body that throws at import time. A clean run here is necessary, not sufficient.

import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOTS = ['js'];

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collect(path, out);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

const files = ROOTS.flatMap((r) => collect(r));
const failed = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed.push(file);
    process.stderr.write(`FAIL ${file}\n${err.stderr?.toString() ?? err.message}\n`);
  }
}

if (failed.length) {
  process.stderr.write(`\n${failed.length}/${files.length} module(s) failed to parse.\n`);
  process.exit(1);
}

process.stdout.write(`OK  ${files.length} modules parsed cleanly.\n`);

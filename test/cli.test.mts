import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.mts', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const usageErrors: readonly (readonly string[])[] = [
  [],
  ['-o', 'x.gif'],
  ['-o', 'x.png', '--repeat', '--shape', 'ellipse'],
  ['-o', 'x.png', '--style', 'stylized', '--finish', 'raw'],
  ['-o', 'x.png', '--palette', 'custom'],
  ['-o', 'x.png', '--palette', 'custom', '--colors', '#fff,#zzz,#000'],
  ['-o', 'x.png', '--colors', '#fff,#888,#000'],
  ['-o', 'x.png', '--regularity', '2'],
  ['-o', 'x.png', '--size', '100by100'],
  ['-o', 'x.png', '--light', '10'],
  ['-o', 'x.png', '--lossless'],
  ['-o', 'x.png', '--quality', '50'],
  ['-o', 'x.png', '--bogus'],
];

for (const args of usageErrors) {
  test(`rejects: ${args.join(' ') || '(no arguments)'}`, () => {
    const r = run(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^error: /);
  });
}

test('--help prints usage', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: petoskeystone/);
});

test('renders a file, with flags overriding a config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'petoskeystone-'));
  try {
    const config = join(dir, 'config.json');
    writeFileSync(config, '﻿' + JSON.stringify({ style: 'stylized', palette: 'ocean', size: '64x48', seed: 'abc', 'cell-size': 20 }));
    const out = join(dir, 'out.png');
    const r = run('--config', config, '--size', '80x40', '-o', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /80x40 png, stylized\/ocean, rect, \d+ corallites, seed abc/);
    assert.ok(readFileSync(out).subarray(1, 4).toString() === 'PNG');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

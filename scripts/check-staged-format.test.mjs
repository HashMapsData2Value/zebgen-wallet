import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('format hook checks the index, preserves partial staging, ignores generated files, and supports CI bases', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = mkdtempSync(path.join(tmpdir(), 'staged-format-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const run = (env = {}) =>
    spawnSync(process.execPath, ['scripts/check-staged-format.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, FORMAT_BASE_REF: '', ...env },
    });
  try {
    git('init', '-q');
    symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    cpSync(
      path.join(root, 'scripts/check-staged-format.mjs'),
      path.join(dir, 'scripts/check-staged-format.mjs'),
      { recursive: true },
    );
    cpSync(path.join(root, '.prettierrc.json'), path.join(dir, '.prettierrc.json'));
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(dir, '.prettierignore'), 'generated.js\n');
    writeFileSync(path.join(dir, 'sample.js'), 'const value = 1;\n');
    git('add', '.');
    git(
      '-c',
      'user.name=Formatter Test',
      '-c',
      'user.email=formatter@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
    writeFileSync(path.join(dir, 'sample.js'), 'const value=2\n');
    git('add', 'sample.js');
    writeFileSync(path.join(dir, 'sample.js'), 'const value = 3;\n');
    const index = git('show', ':sample.js');
    assert.equal(run().status, 1);
    assert.equal(git('show', ':sample.js'), index);
    assert.equal(readFileSync(path.join(dir, 'sample.js'), 'utf8'), 'const value = 3;\n');
    git('add', 'sample.js');
    writeFileSync(path.join(dir, 'sample.js'), 'const value=4\n');
    writeFileSync(path.join(dir, 'generated.js'), 'not valid javascript {{{');
    git('add', 'generated.js');
    assert.equal(run().status, 0);
    assert.equal(readFileSync(path.join(dir, 'sample.js'), 'utf8'), 'const value=4\n');
    writeFileSync(path.join(dir, 'example.rs'), 'fn main() {}\n');
    git('add', 'example.rs');
    assert.equal(run().status, 0);
    writeFileSync(path.join(dir, 'example.rs'), 'fn main(){}');
    git('add', 'example.rs');
    assert.equal(run().status, 1);
    git(
      '-c',
      'user.name=Formatter Test',
      '-c',
      'user.email=formatter@example.invalid',
      'commit',
      '-qm',
      'unformatted fixture',
    );
    assert.equal(run().status, 0);
    assert.equal(run({ FORMAT_BASE_REF: 'HEAD~1' }).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

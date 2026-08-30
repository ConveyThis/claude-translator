/**
 * CLI contract tests.
 *
 *   node --test bin/cli.test.mjs
 *
 * `init` writes into whatever directory it is run from, so every test here works in a
 * throwaway directory under os.tmpdir() and never touches the repository.
 *
 * The point of these is the promise the CLI makes in its own help text: it does not
 * overwrite what you already have, and it tells you every path it touched. A scaffolder
 * that quietly breaks that promise is worse than no scaffolder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), 'claude-translator.mjs');
const PKG = JSON.parse(readFileSync(resolve(dirname(CLI), '..', 'package.json'), 'utf8'));

/** Run the CLI in a fresh directory. Returns { stdout, status }. */
function run(args, { project = true, dir } = {}) {
  const cwd = dir ?? mkdtempSync(join(tmpdir(), 'ct-cli-'));
  if (project && !existsSync(join(cwd, 'package.json'))) {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2));
  }
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
    return { stdout, status: 0, cwd };
  } catch (err) {
    return { stdout: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status, cwd };
  }
}

test('--version prints the package version', () => {
  const { stdout, status } = run(['--version']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), PKG.version);
});

test('--help documents every command it accepts, and no command it does not', () => {
  const { stdout, status } = run(['--help']);
  assert.equal(status, 0);
  for (const flag of ['init', '--dir', '--force', '--help', '--version']) {
    assert.ok(stdout.includes(flag), `help omits ${flag}`);
  }
  // Every pipeline step the help promises must be a script the package actually ships.
  for (const s of ['extract.mjs', 'translate.mjs', 'build-locales.mjs', 'verify.mjs', 'audit-seo.mjs']) {
    assert.ok(stdout.includes(s), `help omits ${s}`);
    assert.ok(existsSync(resolve(dirname(CLI), '..', 'scripts', s)), `help names ${s}, which does not exist`);
  }
});

test('bare invocation shows help rather than doing something', () => {
  const { stdout, status } = run([]);
  assert.equal(status, 0);
  assert.ok(stdout.includes('USAGE'));
});

test('an unknown command fails loudly', () => {
  const { status, stdout } = run(['frobnicate']);
  assert.equal(status, 1);
  assert.ok(/unknown command/i.test(stdout));
});

test('refuses to install outside a Node project, and leaves nothing behind', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ct-cli-'));
  const { status, stdout } = run(['init'], { project: false, dir: cwd });
  assert.equal(status, 1);
  assert.ok(stdout.includes('No package.json'));
  assert.equal(existsSync(join(cwd, 'scripts')), false, 'scattered files into a non-project');
  rmSync(cwd, { recursive: true, force: true });
});

test('init scaffolds a runnable pipeline', () => {
  const { stdout, status, cwd } = run(['init']);
  assert.equal(status, 0);

  for (const f of [
    'scripts/i18n/extract.mjs',
    'scripts/i18n/translate.mjs',
    'scripts/i18n/build-locales.mjs',
    'scripts/i18n/verify.mjs',
    'scripts/i18n/audit-seo.mjs',
    'scripts/i18n/config.mjs',
    'scripts/i18n/credit.mjs',
    'scripts/i18n/providers/index.mjs',
    'scripts/i18n/providers/anthropic.mjs',
    'scripts/i18n/glossary.mjs',
    'scripts/i18n/format-locale.mjs',
    'scripts/i18n/tqa.mjs',
    'scripts/i18n/tqa-score.mjs',
    'i18n.config.json',
    'glossary.json',
  ]) {
    assert.ok(existsSync(join(cwd, f)), `init did not write ${f}`);
    assert.ok(stdout.includes(f.split('/').pop()), `init wrote ${f} without reporting it`);
  }

  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  assert.ok(manifest.devDependencies?.parse5, 'parse5 was not declared');
  assert.ok(readFileSync(join(cwd, '.gitignore'), 'utf8').includes('i18n/segments/'));
  rmSync(cwd, { recursive: true, force: true });
});

test('the config it writes is valid JSON with the keys the scripts require', () => {
  const { cwd } = run(['init']);
  const cfg = JSON.parse(readFileSync(join(cwd, 'i18n.config.json'), 'utf8'));
  for (const key of ['buildDir', 'baseUrl', 'locales']) {
    assert.ok(key in cfg, `config is missing ${key}`);
  }
  rmSync(cwd, { recursive: true, force: true });
});

test('a second init overwrites nothing and says so', () => {
  const { cwd } = run(['init']);
  const configPath = join(cwd, 'i18n.config.json');
  writeFileSync(configPath, '{"buildDir":"MINE"}');

  const { stdout, status } = run(['init'], { dir: cwd });
  assert.equal(status, 0);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).buildDir, 'MINE', 'clobbered an edited config');
  assert.ok(stdout.includes('Left alone'));
  assert.ok(stdout.includes('already has the block'), 'appended the gitignore block twice');
  rmSync(cwd, { recursive: true, force: true });
});

test('--force is the only way to replace an edited file', () => {
  const { cwd } = run(['init']);
  const configPath = join(cwd, 'i18n.config.json');
  writeFileSync(configPath, '{"buildDir":"MINE"}');

  run(['init', '--force'], { dir: cwd });
  assert.notEqual(JSON.parse(readFileSync(configPath, 'utf8')).buildDir, 'MINE', '--force did not replace');
  rmSync(cwd, { recursive: true, force: true });
});

test('--dir puts the scripts where it is told', () => {
  const { cwd, stdout } = run(['init', '--dir', 'tools/localize']);
  assert.ok(existsSync(join(cwd, 'tools/localize/extract.mjs')));
  assert.equal(existsSync(join(cwd, 'scripts/i18n')), false);
  // The next-steps block must reference the chosen directory, not the default.
  assert.ok(stdout.includes('tools/localize/extract.mjs'));
  rmSync(cwd, { recursive: true, force: true });
});

test('an existing .gitignore is appended to, not replaced', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ct-cli-'));
  writeFileSync(join(cwd, 'package.json'), '{"name":"f","version":"1.0.0"}');
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n.env\n');
  run(['init'], { dir: cwd });
  const gi = readFileSync(join(cwd, '.gitignore'), 'utf8');
  assert.ok(gi.includes('node_modules'), 'dropped existing entries');
  assert.ok(gi.includes('.env'), 'dropped existing entries');
  assert.ok(gi.includes('i18n/segments/'), 'did not append ours');
  rmSync(cwd, { recursive: true, force: true });
});

test('package.json "files" ships everything init needs to copy', () => {
  const root = resolve(dirname(CLI), '..');
  for (const needed of ['bin', 'scripts', 'i18n.config.example.json', 'glossary.example.json']) {
    assert.ok(PKG.files.includes(needed), `"files" omits ${needed}; npx would install a broken package`);
  }
  assert.equal(PKG.bin['claude-translator'], 'bin/claude-translator.mjs');
  assert.ok(existsSync(join(root, PKG.bin['claude-translator'])), 'bin path does not exist');
});

test('init does not vendor our own contract tests into the user project', () => {
  // scripts/*.test.mjs import node:test and assert on internals. Copying them into
  // someone else's repo puts failing, irrelevant tests in their suite.
  const { cwd } = run(['init']);
  const leaked = [
    'scripts/i18n/glossary.test.mjs',
    'scripts/i18n/format-locale.test.mjs',
    'scripts/i18n/tqa-score.test.mjs',
    'scripts/i18n/providers/providers.test.mjs',
  ].filter((f) => existsSync(join(cwd, f)));
  assert.deepEqual(leaked, [], `init leaked test files: ${leaked.join(', ')}`);
  rmSync(cwd, { recursive: true, force: true });
});

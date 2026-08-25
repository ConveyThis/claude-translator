#!/usr/bin/env node
/**
 * claude-translator — project scaffolder.
 *
 *   npx claude-translator init
 *
 * Does in one command what the README's four manual steps do: copies the pipeline into
 * your project, writes a config, adds the one dependency, and tells you what to run next.
 *
 * ── Why it copies the scripts instead of running them from node_modules ──────
 * The scripts are meant to be yours. They resolve `parse5` and every relative path from
 * the project they sit in, they are short enough to read, and this is AGPL software whose
 * whole point is that you can change it. Vendoring them keeps all of that true. The
 * alternative — a black-box binary reaching into your build output — is the thing this
 * project exists as an alternative to.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 * Never overwrite anything the user has without --force, and print every path touched.
 * A scaffolder that silently clobbers a config people have edited is worse than no
 * scaffolder at all.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));

// ── Output ───────────────────────────────────────────────────────────────────

const c = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m' }
  : { dim: '', bold: '', green: '', yellow: '', reset: '' };

const wrote = [];
const skipped = [];

const say = (s = '') => console.log(s);
const ok = (path) => wrote.push(path);
const skip = (path, why) => skipped.push(`${path} ${c.dim}(${why})${c.reset}`);

// ── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `
${c.bold}claude-translator${c.reset} ${pkg.version}
Static-site localization: translate a built site into dozens of languages as real
static pages, without re-rendering and without breaking Core Web Vitals.

${c.bold}USAGE${c.reset}
  npx claude-translator init [options]

${c.bold}OPTIONS${c.reset}
  --dir <path>    Where to put the pipeline scripts   (default: scripts/i18n)
  --force         Overwrite files that already exist  (default: never)
  --help, -h      Show this
  --version, -v   Print the version

${c.bold}AFTER INIT${c.reset}
  npm install                                    install parse5, the only dependency
  \$EDITOR i18n.config.json                       set baseUrl, locales, provider
  node <dir>/extract.mjs                         find translatable units
  node <dir>/translate.mjs --lang es,fr          translate
  node <dir>/build-locales.mjs --lang all        write the localized pages
  node <dir>/verify.mjs --lang all               six gates
  node <dir>/audit-seo.mjs                       full SEO audit

${c.bold}DOCS${c.reset}  https://github.com/ConveyThis/claude-translator
`;

const argv = process.argv.slice(2);
const has = (...names) => names.some((n) => argv.includes(n));
const valueOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

if (has('--help', '-h') || argv.length === 0) {
  say(HELP);
  process.exit(0);
}
if (has('--version', '-v')) {
  say(pkg.version);
  process.exit(0);
}

const command = argv[0];
if (command !== 'init') {
  console.error(`Unknown command "${command}". Run \`npx claude-translator --help\`.`);
  process.exit(1);
}

const FORCE = has('--force');
const DIR = valueOf('--dir', 'scripts/i18n');
const CWD = process.cwd();

// ── Guard: is this a project? ────────────────────────────────────────────────
// Scattering files into whatever directory someone happened to be in is the kind of
// thing people remember about a tool.

const pkgJsonPath = join(CWD, 'package.json');
if (!existsSync(pkgJsonPath)) {
  console.error(`No package.json in ${CWD}

claude-translator init installs into a Node project, because the scripts need parse5
and resolve paths from the project root. Run it from your project, or create one first:

  npm init -y && npx claude-translator init
`);
  process.exit(1);
}

say(`\n${c.bold}claude-translator ${pkg.version}${c.reset}  →  ${CWD}\n`);

// ── 1. The pipeline scripts ──────────────────────────────────────────────────

/** Copy one file, honouring --force, recording what happened. */
function place(from, to, label = relative(CWD, to)) {
  if (existsSync(to) && !FORCE) {
    skip(label, 'exists — use --force to replace');
    return;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  ok(label);
}

const targetDir = resolve(CWD, DIR);
const srcDir = join(PKG_ROOT, 'scripts');

for (const entry of readdirSync(srcDir)) {
  const from = join(srcDir, entry);
  if (statSync(from).isDirectory()) {
    for (const sub of readdirSync(from)) {
      place(join(from, sub), join(targetDir, entry, sub));
    }
    continue;
  }
  if (!/\.(mjs|sh)$/.test(entry)) continue;
  place(from, join(targetDir, entry));
}

// ── 2. The config ────────────────────────────────────────────────────────────

place(join(PKG_ROOT, 'i18n.config.example.json'), join(CWD, 'i18n.config.json'), 'i18n.config.json');

// ── 3. The one dependency ────────────────────────────────────────────────────
// Written into package.json rather than installed here: running npm from inside npx is
// slow, can pick the wrong package manager, and rewrites a lockfile the user did not ask
// us to touch. Editing the manifest and saying "now run install" is the honest version.

let needsInstall = false;
{
  const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const declared =
    manifest.dependencies?.parse5 ?? manifest.devDependencies?.parse5 ?? manifest.peerDependencies?.parse5;
  if (declared) {
    skip('package.json', `parse5 already declared (${declared})`);
  } else {
    manifest.devDependencies = { ...(manifest.devDependencies ?? {}), parse5: '^7.3.0' };
    // Keep devDependencies sorted so the diff is one line, not a reshuffle.
    manifest.devDependencies = Object.fromEntries(Object.entries(manifest.devDependencies).sort());
    writeFileSync(pkgJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
    ok('package.json  (added parse5 to devDependencies)');
    needsInstall = true;
  }
}

// ── 4. .gitignore ────────────────────────────────────────────────────────────
// The memory files are the asset. Everything else under i18n/ is derived and noisy.

const GITIGNORE_BLOCK = [
  '',
  '# claude-translator — derived files. Do NOT ignore i18n/tm/{lang}.json:',
  '# the translation memory is the asset, and losing it means paying to rebuild it.',
  'i18n/source.json',
  'i18n/manifest.json',
  'i18n/segments/',
  'i18n/seo-audit.json',
  'i18n/tm/*.failures.json',
  'i18n/tm/*.review.json',
  '',
];

{
  const gitignorePath = join(CWD, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (existing.includes('claude-translator — derived files')) {
    skip('.gitignore', 'already has the block');
  } else {
    writeFileSync(gitignorePath, existing.replace(/\n*$/, '\n') + GITIGNORE_BLOCK.join('\n'));
    ok(existing ? '.gitignore  (appended)' : '.gitignore');
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (wrote.length) {
  say(`${c.green}Wrote${c.reset}`);
  for (const w of wrote) say(`  ${w}`);
}
if (skipped.length) {
  say(`\n${c.yellow}Left alone${c.reset}`);
  for (const s of skipped) say(`  ${s}`);
}

// Column width is computed, not guessed: --dir changes how long these commands are, and
// a hardcoded pad lets the longest one collide with its own description.
const rows = [
  ...(needsInstall ? [['npm install', 'parse5, the only dependency']] : []),
  ['$EDITOR i18n.config.json', 'baseUrl, locales, provider'],
  [],
  ['npm run build', 'your normal build, source language only'],
  [`node ${DIR}/extract.mjs`, 'find translatable units'],
  [`node ${DIR}/translate.mjs --lang es,fr`, 'translate (needs a provider key)'],
  [`node ${DIR}/build-locales.mjs --lang all`, 'write the localized pages'],
  [`node ${DIR}/verify.mjs --lang all`, 'six gates'],
  [`node ${DIR}/audit-seo.mjs`, 'full SEO audit'],
];
const width = Math.max(...rows.filter((r) => r.length).map(([cmd]) => cmd.length)) + 2;

say(`\n${c.bold}Next${c.reset}`);
for (const row of rows) {
  if (!row.length) { say(''); continue; }
  const [cmd, note] = row;
  say(`  ${cmd.padEnd(width)}${c.dim}${note}${c.reset}`);
}

say(`\n${c.dim}Deploy the build directory exactly as you deploy it today.`);
say(`Docs: https://github.com/ConveyThis/claude-translator${c.reset}\n`);

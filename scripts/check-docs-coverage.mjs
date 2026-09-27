#!/usr/bin/env node
/**
 * Documentation-drift gate: the public surface in the CODE must appear in the DOCS.
 *
 *     node scripts/check-docs-coverage.mjs            # surface + release metadata + offline quickstart
 *     node scripts/check-docs-coverage.mjs --online   # also run the quickstart blocks that call live APIs
 *     node scripts/check-docs-coverage.mjs --no-run   # skip building and executing the quickstart
 *     npm run docs:check                              # same as the first form
 *
 * Exit 0 = every public token is documented and the quickstart runs; exit 1 = drift, with
 * every missing item listed. Pinned two-sided by `tests/docsCoverageGate.test.ts`, which
 * runs as part of `npm test`.
 *
 * WHY THIS EXISTS (2026-09-27). The README named a third of the exports of `src/index.ts`,
 * none of the result fields or issue codes, and claimed the library "never reads
 * environment variables" while `formatError` reads `NODE_ENV`. Nothing failed, because
 * nothing compared the docs with the code. This does. The surface is DERIVED with the
 * TypeScript compiler from `src/index.ts` (every export, every field of an exported
 * interface or returned object literal, every string-literal value, every function
 * parameter), plus every `code: '...'` an issue can carry, every `process.env.X` read in
 * `src/` or `scripts/`, and every `--flag` a maintainer script parses. There is no
 * hand-kept list here to forget to update: a new export is covered the moment it exists.
 *
 * A quickstart js block whose first line is `// requires network` runs only with
 * `--online`, so the offline gate cannot fail because an external API is slow.
 *
 * "Documented" means: appears inside an inline code span or a fenced code block of
 * README.md or docs/API.md. A prose mention does not count.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOC_FILES = ['README.md', 'docs/API.md'];
const QUICKSTART_HEADING = '## Quickstart';

// --------------------------------------------------------------------------- surface
function stringLiterals(type, out) {
  if (type.isUnion()) for (const t of type.types) stringLiterals(t, out);
  else if (type.isStringLiteral()) out.add(type.value);
}

function objectMembers(checker, type, fields, values, seen) {
  if (seen.has(type)) return;
  seen.add(type);
  if (type.isUnion()) {
    for (const t of type.types) objectMembers(checker, t, fields, values, seen);
    return;
  }
  stringLiterals(type, values);
  if (checker.isArrayType(type)) {
    for (const t of checker.getTypeArguments(type)) objectMembers(checker, t, fields, values, seen);
    return;
  }
  // Only ANONYMOUS object shapes are walked: a named interface is its own export and is
  // walked from there, and a library type (string, Record) has no fields of ours.
  const sym = type.getSymbol();
  if (!sym || !(sym.flags & ts.SymbolFlags.TypeLiteral)) return;
  for (const prop of checker.getPropertiesOfType(type)) {
    fields.add(prop.name);
    objectMembers(checker, checker.getTypeOfSymbol(prop), fields, values, seen);
  }
}

function walk(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full, ext);
    return e.name.endsWith(ext) ? [full] : [];
  });
}

// A comment that SAYS "never reads process.env.X" is not a read.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every public token, grouped by kind, derived from the source. */
export function collectSurface(root = ROOT) {
  const entry = path.join(root, 'src', 'index.ts');
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`cannot read ${entry}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);

  const surface = {
    export: new Set(),
    field: new Set(),
    value: new Set(),
    parameter: new Set(),
    'issue code': new Set(),
    'env var': new Set(),
    'script flag': new Set(),
  };
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    surface.export.add(exported.name);
    const sym = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const decl = sym.declarations?.[0];
    if (!decl) continue;
    if (ts.isInterfaceDeclaration(decl)) {
      for (const prop of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(sym))) {
        surface.field.add(prop.name);
        objectMembers(checker, checker.getTypeOfSymbol(prop), surface.field, surface.value, new Set());
      }
    } else if (ts.isTypeAliasDeclaration(decl)) {
      stringLiterals(checker.getDeclaredTypeOfSymbol(sym), surface.value);
    } else if (ts.isVariableDeclaration(decl)) {
      // A union-typed constant lists its values; a single-literal constant IS its value
      // (a URL, a contact address) and is documented by name, not by content.
      const type = checker.getTypeOfSymbol(sym);
      if (type.isUnion()) stringLiterals(type, surface.value);
    } else if (ts.isFunctionDeclaration(decl)) {
      const sig = checker.getSignatureFromDeclaration(decl);
      for (const p of sig.getParameters()) {
        if (!p.name.startsWith('_')) surface.parameter.add(p.name);
      }
      objectMembers(checker, sig.getReturnType(), surface.field, surface.value, new Set());
    }
  }

  const codeRe = /\bcode:\s*'([A-Z][A-Z0-9_]+)'/g;
  const envRe = /process\.env\.([A-Z][A-Z0-9_]+)/g;
  for (const file of walk(path.join(root, 'src'), '.ts')) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(codeRe)) surface['issue code'].add(m[1]);
    for (const m of stripComments(text).matchAll(envRe)) surface['env var'].add(m[1]);
  }
  const self = path.resolve(fileURLToPath(import.meta.url));
  for (const file of walk(path.join(root, 'scripts'), '.mjs')) {
    if (path.resolve(file) === self) continue; // this gate's own flags are documented in CONTRIBUTING.md
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of text.matchAll(envRe)) surface['env var'].add(m[1]);
    for (const m of text.matchAll(/argv\.includes\(\s*'(--[a-z][a-z0-9-]*)'/g)) surface['script flag'].add(m[1]);
  }
  return surface;
}

// --------------------------------------------------------------------------- docs
const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;
const INLINE_RE = /`([^`\n]+)`/g;

export function documentedCodeText(docFiles = DOC_FILES, root = ROOT) {
  const chunks = [];
  for (const rel of docFiles) {
    const text = fs.readFileSync(path.resolve(root, rel), 'utf8');
    for (const m of text.matchAll(FENCE_RE)) chunks.push(m[1]);
    for (const m of text.replace(FENCE_RE, '').matchAll(INLINE_RE)) chunks.push(m[1]);
  }
  return chunks.join('\n');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isDocumented(token, code) {
  return new RegExp(`(?<![\\w-])${escapeRe(token)}(?![\\w-])`).test(code);
}

export function findUndocumented(surface, code) {
  const missing = [];
  for (const [kind, tokens] of Object.entries(surface)) {
    for (const token of tokens) if (!isDocumented(token, code)) missing.push(`${kind}: ${token}`);
  }
  return missing.sort();
}

// --------------------------------------------------------------------------- release metadata
/** The newest `## x.y.z` changelog heading and its notes. */
export function latestChangelogSection(root = ROOT) {
  const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const heads = [...text.matchAll(/^## \[?(\d+\.\d+\.\d+[^\]\s]*)\]?/gm)];
  if (!heads.length) throw new Error("CHANGELOG.md has no '## x.y.z' heading");
  const end = heads.length > 1 ? heads[1].index : text.length;
  return [heads[0][1], text.slice(heads[0].index, end)];
}

/** Changelog, README install pin and CITATION.cff must name package.json's version. */
export function checkReleaseMetadata(surface, code, root = ROOT) {
  const problems = [];
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const [changelogVersion, section] = latestChangelogSection(root);
  if (changelogVersion !== version) {
    problems.push(`changelog: newest entry is ${changelogVersion}, package.json says ${version}`);
  }
  const checks = [
    ['README.md', /referencecheck#v(\d+\.\d+\.\d+)/, 'install pin'],
    ['CITATION.cff', /^version:\s*"?(\d+\.\d+\.\d+)/m, 'citation'],
  ];
  for (const [rel, re, label] of checks) {
    const file = path.join(root, rel);
    const m = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').match(re) : null;
    if (!m) problems.push(`${label}: no version found in ${rel}`);
    else if (m[1] !== version) problems.push(`${label}: ${rel} names ${m[1]}, package.json says ${version}`);
  }
  const every = new Set(Object.values(surface).flatMap((s) => [...s]));
  for (const m of section.replace(FENCE_RE, '').matchAll(INLINE_RE)) {
    const token = m[1].trim();
    if (every.has(token) && !isDocumented(token, code)) {
      problems.push(`changelog ${changelogVersion}: \`${token}\` is named in the release notes but not in the docs`);
    }
  }
  return problems.sort();
}

// --------------------------------------------------------------------------- quickstart
export function quickstartBlocks(readme) {
  const text = readme ?? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const start = text.indexOf(QUICKSTART_HEADING);
  if (start < 0) throw new Error(`README.md has no '${QUICKSTART_HEADING}' section`);
  const next = text.indexOf('\n## ', start + QUICKSTART_HEADING.length);
  const body = text.slice(start, next > 0 ? next : text.length);
  const blocks = [...body.matchAll(/```(js|javascript|mjs)\n([\s\S]*?)```/g)].map((m) => ({
    code: m[2],
    online: /^\/\/ requires network/.test(m[2]),
  }));
  if (!blocks.some((b) => !b.online)) {
    throw new Error('README quickstart has no offline js block -- nothing would be executed');
  }
  return blocks;
}

/** Build dist/ (tsc + bundled data), install this tree as `referencecheck` in a temp dir, run the quickstart. */
export function runQuickstart(online = false) {
  const problems = [];
  const steps = [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(ROOT, 'scripts', 'copy-data.mjs'),
  ];
  for (const step of steps) {
    const r = spawnSync(process.execPath, [step], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) return [`build: ${path.basename(step)} exited ${r.status}:\n${(r.stdout + r.stderr).slice(-1500)}`];
  }

  const all = quickstartBlocks();
  const blocks = all.filter((b) => online || !b.online).map((b) => b.code);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'referencecheck-quickstart-'));
  try {
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    // A junction needs no elevation on Windows; elsewhere the type argument is ignored.
    fs.symlinkSync(ROOT, path.join(tmp, 'node_modules', 'referencecheck'), 'junction');
    blocks.forEach((code, i) => {
      const file = path.join(tmp, `quickstart-${i + 1}.mjs`);
      fs.writeFileSync(file, code);
      const r = spawnSync(process.execPath, [file], { cwd: tmp, encoding: 'utf8', timeout: 120000 });
      if (r.status !== 0 || !r.stdout.trim()) {
        problems.push(`quickstart js block ${i + 1} exited ${r.status} with ${r.stdout.length} chars of output:\n${(r.stderr || '').slice(-1500)}`);
      }
    });
  } finally {
    fs.unlinkSync(path.join(tmp, 'node_modules', 'referencecheck'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const skipped = all.length - blocks.length;
  if (!problems.length) {
    console.log(`quickstart: ${blocks.length} js block(s) built and ran OK` +
      (skipped ? ` (${skipped} network block(s) skipped; pass --online to run them)` : ''));
  }
  return problems;
}

export function main(argv = process.argv.slice(2)) {
  const surface = collectSurface();
  if (surface.export.size === 0) {
    console.log('FAIL: derived an EMPTY public surface -- the instrument is broken, not the docs clean');
    return 1;
  }
  const code = documentedCodeText();
  const problems = [...findUndocumented(surface, code), ...checkReleaseMetadata(surface, code)];
  if (!argv.includes('--no-run')) problems.push(...runQuickstart(argv.includes('--online')));
  const n = Object.values(surface).reduce((a, s) => a + s.size, 0);
  if (problems.length) {
    console.log(`FAIL: ${problems.length} documentation problem(s) against ${n} public tokens:`);
    for (const p of problems) console.log(`  - ${p}`);
    return 1;
  }
  const counts = Object.entries(surface).map(([k, s]) => `${s.size} ${k}`).join(', ');
  console.log(`OK: all ${n} public tokens documented (${counts})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

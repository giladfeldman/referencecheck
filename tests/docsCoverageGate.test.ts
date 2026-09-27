/**
 * Two-sided pin for scripts/check-docs-coverage.mjs (the documentation-drift gate).
 *
 * A gate that passes on the real repo proves nothing unless it is also shown to FAIL when
 * the thing it guards is broken -- otherwise an empty derived surface or a pattern that
 * matches everything would read as "fully documented". Each planted case below must be
 * caught. The quickstart execution (which builds dist/) is left to `npm run docs:check`.
 */

import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore -- plain ESM script without type declarations
import * as gate from '../scripts/check-docs-coverage.mjs';

const surface: Record<string, Set<string>> = gate.collectSurface();
const code: string = gate.documentedCodeText();

describe('documentation-drift gate', () => {
  it('derives a non-empty surface from the source (known-positive control)', () => {
    expect(surface.export.has('checkRetractionDetailed')).toBe(true);
    expect(surface.export.has('DEFAULT_POLITE_EMAIL')).toBe(true);
    expect(surface.field.has('sourcesUnavailable')).toBe(true);
    expect(surface.field.has('openAccessStatus')).toBe(true); // nested anonymous object type
    expect(surface.field.has('bronzeOA')).toBe(true); // returned object literal
    expect(surface.value.has('partial_retraction')).toBe(true);
    expect(surface.value.has('unexpanded-target')).toBe(true);
    expect(surface.parameter.has('useOpenAlex')).toBe(true);
    expect(surface['issue code'].has('HAS_PREPRINT_VERSION')).toBe(true);
    expect(surface['env var'].has('NODE_ENV')).toBe(true); // read in src/util/formatError.ts
    expect(surface['env var'].has('CROSSREF_EMAIL')).toBe(true); // read in scripts/live-check.mjs
    expect(surface['script flag'].has('--verbose')).toBe(true);
    // A single-literal constant is documented by name, never by value (it is an address).
    expect([...surface.value].some((v) => v.includes('@'))).toBe(false);
    expect(surface.export.size).toBeGreaterThan(60);
  });

  it('passes on the real repository', () => {
    expect(gate.findUndocumented(surface, code)).toEqual([]);
    expect(gate.checkReleaseMetadata(surface, code)).toEqual([]);
  });

  it.each([
    ['export', 'plantedUndocumentedExport'],
    ['field', 'plantedUndocumentedField'],
    ['value', 'planted-undocumented-value'],
    ['parameter', 'plantedUndocumentedParam'],
    ['issue code', 'PLANTED_UNDOCUMENTED_CODE'],
    ['env var', 'PLANTED_UNDOCUMENTED_ENV'],
    ['script flag', '--planted-undocumented-flag'],
  ])('fails on a planted undocumented %s', (kind, token) => {
    const planted: Record<string, Set<string>> = {};
    for (const [k, v] of Object.entries(surface)) planted[k] = new Set(v);
    planted[kind].add(token);
    expect(gate.findUndocumented(planted, code)).toEqual([`${kind}: ${token}`]);
  });

  it('counts only code spans and fenced blocks, and whole tokens only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'referencecheck-docs-gate-'));
    const doc = path.join(dir, 'doc.md');
    fs.writeFileSync(doc, 'A Widget in prose.\n\n`Gadget` inline.\n\n```ts\nimport { Gizmo } from "x";\n```\n');
    const text: string = gate.documentedCodeText([doc]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(gate.isDocumented('Widget', text)).toBe(false);
    expect(gate.isDocumented('Gadget', text)).toBe(true);
    expect(gate.isDocumented('Gizmo', text)).toBe(true);
    // A prefix must not satisfy a longer name, nor a longer name a prefix.
    expect(gate.isDocumented('checkRetraction', 'checkRetractionDetailed')).toBe(false);
    expect(gate.isDocumented('checkRetractionDetailed', 'checkRetraction')).toBe(false);
  });

  it('refuses a quickstart with no offline js block', () => {
    expect(() => gate.quickstartBlocks('# x\n\n## Quickstart\n\nno code here\n\n## Next\n')).toThrow();
    const onlineOnly = '## Quickstart\n\n```js\n// requires network\nawait f();\n```\n';
    expect(() => gate.quickstartBlocks(onlineOnly)).toThrow();
  });

  it('marks the README network block so the offline gate skips it', () => {
    const blocks: { online: boolean }[] = gate.quickstartBlocks();
    expect(blocks.some((b) => !b.online)).toBe(true);
    expect(blocks.some((b) => b.online)).toBe(true);
  });
});

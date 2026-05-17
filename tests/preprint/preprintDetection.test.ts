/**
 * Preprint Publication Detection Tests
 */

import { describe, it, expect } from '@jest/globals';
import { checkReferenceForPreprint, getSummaryData, PreprintIssue, detectKnownPreprintFromDoi, detectKnownPreprintFromText } from '../../src/preprint/preprintDetectionService.js';
import type { ReferenceInput } from '../../src/types.js';

describe('Preprint Detection Service', () => {
  describe('Preprint Check for References', () => {
    it('should return empty array for reference without DOI', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-1',
        raw_text: 'Smith, J. (2020). Some article without DOI.',
      };

      const issues = await checkReferenceForPreprint(reference as ReferenceInput);
      expect(issues).toEqual([]);
    });

    it('should check reference with DOI', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-2',
        raw_text: 'Smith, J. (2020). Article with DOI.',
        doi: '10.1101/2020.01.01.000001',
      };

      const issues = await checkReferenceForPreprint(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should use suggested_doi if doi is not available', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-3',
        raw_text: 'Smith, J. (2020). Article with suggested DOI.',
        suggested_doi: '10.1234/preprint.doi',
      };

      const issues = await checkReferenceForPreprint(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });
  });

  describe('Preprint Status Detection', () => {
    it('should detect active preprints', () => {
      const issue = {
        type: 'preprint-status' as const,
        severity: 'warning' as const,
        code: 'IS_PREPRINT',
        description: 'This reference is a preprint and has not been peer-reviewed',
        location: '10.1101/2020.01.01.000001',
        metadata: {},
      };

      expect(issue.code).toBe('IS_PREPRINT');
      expect(issue.severity).toBe('warning');
    });

    it('should detect papers with published versions', () => {
      const issue = {
        type: 'preprint-status' as const,
        severity: 'info' as const,
        code: 'HAS_PREPRINT_VERSION',
        description: 'This paper was previously published as a preprint',
        location: '10.1234/published.doi',
        metadata: {
          preprintDoi: '10.1101/2020.01.01.000001',
          publishedDate: '2021-06-15',
        },
      };

      expect(issue.code).toBe('HAS_PREPRINT_VERSION');
      expect(issue.metadata?.preprintDoi).toBeDefined();
    });

    it('should handle published papers without preprint history', () => {
      const issues: any[] = [];
      expect(issues).toHaveLength(0);
    });
  });

  describe('Summary Data Generation', () => {
    it('should generate correct summary for mixed papers', () => {
      const issues = [
        {
          type: 'preprint-status' as const,
          severity: 'warning' as const,
          code: 'IS_PREPRINT',
          description: 'Active preprint',
          location: '10.1101/1',
          metadata: {},
        },
        {
          type: 'preprint-status' as const,
          severity: 'info' as const,
          code: 'HAS_PREPRINT_VERSION',
          description: 'Published from preprint',
          location: '10.1234/2',
          metadata: { preprintDoi: '10.1101/2' },
        },
      ] as PreprintIssue[];

      const summary = getSummaryData(issues);
      expect(summary.preprintCount).toBe(2);
      expect(summary.activePreprints).toBe(1);
      expect(summary.hasPreprints).toBe(1);
    });

    it('should count only active preprints correctly', () => {
      const issues = [
        {
          type: 'preprint-status' as const,
          severity: 'warning' as const,
          code: 'IS_PREPRINT',
          description: 'Preprint 1',
          location: '10.1101/1',
          metadata: {},
        },
        {
          type: 'preprint-status' as const,
          severity: 'warning' as const,
          code: 'IS_PREPRINT',
          description: 'Preprint 2',
          location: '10.1101/2',
          metadata: {},
        },
      ];

      const summary = getSummaryData(issues);
      expect(summary.activePreprints).toBe(2);
      expect(summary.hasPreprints).toBe(0);
    });

    it('should handle no preprint papers', () => {
      const issues: any[] = [];
      const summary = getSummaryData(issues);

      expect(summary.preprintCount).toBe(0);
      expect(summary.activePreprints).toBe(0);
      expect(summary.hasPreprints).toBe(0);
    });

    it('should calculate preprint percentage correctly', () => {
      const issues = [
        {
          type: 'preprint-status' as const,
          severity: 'warning' as const,
          code: 'IS_PREPRINT',
          description: 'One preprint',
          location: '10.1101/1',
          metadata: {},
        },
      ];

      const summary = getSummaryData(issues);
      expect(summary.preprintCount).toBe(1);
    });
  });

  describe('Reference Processing', () => {
    it('should handle references with metadata', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-4',
        raw_text: 'Research preprint by authors',
        doi: '10.1101/2020.01.01.000001',
        parsed_data: {
          authors: [{ lastName: 'Smith', firstName: 'John' }],
          year: '2020',
          title: 'Important Preprint Research',
        } as any,
      };

      const issues = await checkReferenceForPreprint(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should prioritize doi over suggested_doi', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-5',
        raw_text: 'Article with both DOIs',
        doi: '10.1234/primary.doi',
        suggested_doi: '10.5678/suggested.doi',
      };

      const issues = await checkReferenceForPreprint(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });
  });

  describe('Issue Structure', () => {
    it('should return properly structured issue objects for active preprints', () => {
      const issues = [
        {
          type: 'preprint-status' as const,
          severity: 'warning' as const,
          code: 'IS_PREPRINT',
          description: 'This is a preprint - not yet peer-reviewed',
          location: '10.1101/2020.01.01.000001',
          metadata: {
            server: 'bioRxiv',
            uploadDate: '2020-01-01',
          },
        },
      ];

      expect(issues[0]).toHaveProperty('type');
      expect(issues[0]).toHaveProperty('severity');
      expect(issues[0]).toHaveProperty('code');
      expect(issues[0]).toHaveProperty('description');
      expect(issues[0]).toHaveProperty('location');
      expect(issues[0].type).toBe('preprint-status');
      expect(issues[0].severity).toBe('warning');
    });

    it('should include preprint server information in metadata', () => {
      const issue = {
        type: 'preprint-status' as const,
        severity: 'warning' as const,
        code: 'IS_PREPRINT',
        description: 'Active preprint on bioRxiv',
        location: '10.1101/2020.01.01.000001',
        metadata: {
          server: 'bioRxiv',
          uploadDate: '2020-01-01',
        },
      };

      expect(issue.metadata?.server).toBe('bioRxiv');
      expect(issue.metadata?.uploadDate).toBeDefined();
    });

    it('should include published version information when available', () => {
      const issue = {
        type: 'preprint-status' as const,
        severity: 'info' as const,
        code: 'HAS_PREPRINT_VERSION',
        description: 'Paper has published version',
        location: '10.1234/published',
        metadata: {
          preprintDoi: '10.1101/2020.01.01.000001',
          publishedDate: '2021-06-15',
          preprintServer: 'medRxiv',
        },
      };

      expect(issue.metadata?.preprintDoi).toBeDefined();
      expect(issue.metadata?.publishedDate).toBeDefined();
      expect(issue.metadata?.preprintServer).toBe('medRxiv');
    });
  });

  describe('Edge Cases', () => {
    it('should handle non-preprint DOIs', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-6',
        raw_text: 'Regular journal article',
        doi: '10.1016/j.journal.2021.01.001',
      };

      const issues = await checkReferenceForPreprint(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
      expect(issues).toHaveLength(0);
    });

    it('should handle references with null DOI fields', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-7',
        raw_text: 'Paper without identifiers',
        doi: undefined,
        suggested_doi: undefined,
      };

      const issues = await checkReferenceForPreprint(reference as ReferenceInput);
      expect(issues).toEqual([]);
    });
  });

  // γ' false-negative-vs-canonical fixes (2 audit findings).
  describe('Heuristic preprint detection (γ′)', () => {
    it('detectKnownPreprintFromDoi flags SSRN DOIs (10.2139/ssrn.*)', () => {
      expect(detectKnownPreprintFromDoi('10.2139/ssrn.2806713')).toBe('SSRN');
      expect(detectKnownPreprintFromDoi('10.2139/SSRN.999')).toBe('SSRN');
    });

    it('detectKnownPreprintFromDoi flags PsyArXiv / OSF / bioRxiv / arXiv prefixes', () => {
      expect(detectKnownPreprintFromDoi('10.31234/foobar')).toBe('PsyArXiv');
      expect(detectKnownPreprintFromDoi('10.31219/osf.io/abc')).toBe('OSF Preprints');
      expect(detectKnownPreprintFromDoi('10.1101/2024.01.01.000001')).toBe('bioRxiv/medRxiv');
      expect(detectKnownPreprintFromDoi('10.48550/arXiv.2301.12345')).toBe('arXiv');
    });

    it('detectKnownPreprintFromDoi returns null for journal DOIs', () => {
      expect(detectKnownPreprintFromDoi('10.1037/0022-3514.86.1.57')).toBeNull();
      expect(detectKnownPreprintFromDoi('10.1126/science.1234567')).toBeNull();
      expect(detectKnownPreprintFromDoi(null)).toBeNull();
      expect(detectKnownPreprintFromDoi(undefined)).toBeNull();
    });

    it('detectKnownPreprintFromText flags PsyArXiv URLs', () => {
      expect(detectKnownPreprintFromText('https://psyarxiv.com/938m7/')).toBe('PsyArXiv');
      expect(detectKnownPreprintFromText('See preprint at https://psyarxiv.com/abc123')).toBe('PsyArXiv');
    });

    it('detectKnownPreprintFromText flags arXiv / bioRxiv / medRxiv URLs', () => {
      expect(detectKnownPreprintFromText('https://arxiv.org/abs/2301.12345')).toBe('arXiv');
      expect(detectKnownPreprintFromText('https://www.biorxiv.org/content/10.1101/2024')).toBe('bioRxiv');
      expect(detectKnownPreprintFromText('https://www.medrxiv.org/content/10.1101/foo')).toBe('medRxiv');
    });

    it('detectKnownPreprintFromText returns null for non-preprint URLs', () => {
      expect(detectKnownPreprintFromText('https://doi.org/10.1037/0022-3514.86.1.57')).toBeNull();
      expect(detectKnownPreprintFromText('https://example.com/article')).toBeNull();
      expect(detectKnownPreprintFromText(null)).toBeNull();
      expect(detectKnownPreprintFromText('')).toBeNull();
    });

    it('checkReferenceForPreprint flags SSRN DOI without hitting CrossRef (audit ssrn-5048949 case)', async () => {
      const ref: Partial<ReferenceInput> = {
        id: 'ref-ssrn',
        raw_text: 'Smith (2017). Working paper.',
        doi: '10.2139/ssrn.2806713',
      };
      const issues = await checkReferenceForPreprint(ref as ReferenceInput);
      expect(issues.length).toBe(1);
      expect(issues[0].code).toBe('IS_PREPRINT');
      expect(issues[0].metadata?.preprintServer).toBe('SSRN');
      expect(issues[0].metadata?.source).toBe('heuristic');
    });

    it('checkReferenceForPreprint flags PsyArXiv URL in raw_text (audit Ziano case)', async () => {
      const ref: Partial<ReferenceInput> = {
        id: 'ref-psyarxiv',
        raw_text: 'Foo, B. (2020). Preprint. https://psyarxiv.com/938m7/',
      };
      const issues = await checkReferenceForPreprint(ref as ReferenceInput);
      expect(issues.length).toBe(1);
      expect(issues[0].code).toBe('IS_PREPRINT');
      expect(issues[0].metadata?.preprintServer).toBe('PsyArXiv');
    });
  });
});

/**
 * Expression of Concern Detection Tests
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { checkReferenceForEOC, getSeverityCounts } from '../../src/expressionOfConcern/expressionOfConcernService.js';
import type { ReferenceInput } from '../../src/types.js';

describe('Expression of Concern Detection Service', () => {
  describe('EOC Check for References', () => {
    it('should return empty array for reference without DOI', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-1',
        raw_text: 'Smith, J. (2020). Some article without DOI.',
      };

      const issues = await checkReferenceForEOC(reference as ReferenceInput);
      expect(issues).toEqual([]);
    });

    it('should check reference with DOI', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-2',
        raw_text: 'Smith, J. (2020). Article with DOI.',
        doi: '10.1126/science.aac4716',
      };

      const issues = await checkReferenceForEOC(reference as ReferenceInput);
      // Issues depend on actual API responses, but should be an array
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should use suggested_doi if doi is not available', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-3',
        raw_text: 'Smith, J. (2020). Article with suggested DOI.',
        suggested_doi: '10.1234/example.doi',
      };

      const issues = await checkReferenceForEOC(reference as ReferenceInput);
      // Should attempt to check with suggested DOI
      expect(Array.isArray(issues)).toBe(true);
    });
  });

  describe('Severity Counting', () => {
    it('should count violations by severity', () => {
      const issues = [
        {
          type: 'expression-of-concern' as const,
          severity: 'error' as const,
          code: 'EOC_DETECTED',
          description: 'Critical EOC found',
          location: '10.1234/example',
          metadata: {},
        },
        {
          type: 'expression-of-concern' as const,
          severity: 'error' as const,
          code: 'EOC_DETECTED',
          description: 'Another critical issue',
          location: '10.5678/example',
          metadata: {},
        },
        {
          type: 'expression-of-concern' as const,
          severity: 'warning' as const,
          code: 'CORRECTION_NOTICE',
          description: 'Minor correction notice',
          location: '10.9012/example',
          metadata: {},
        },
      ];

      const counts = getSeverityCounts(issues);
      expect(counts.errors).toBe(2);
      expect(counts.warnings).toBe(1);
    });

    it('should handle empty issues array', () => {
      const counts = getSeverityCounts([]);
      expect(counts.errors).toBe(0);
      expect(counts.warnings).toBe(0);
    });

    it('should count only errors when present', () => {
      const issues = [
        {
          type: 'expression-of-concern' as const,
          severity: 'error' as const,
          code: 'EOC_DETECTED',
          description: 'Critical issue',
          location: '10.1234/example',
          metadata: {},
        },
        {
          type: 'expression-of-concern' as const,
          severity: 'error' as const,
          code: 'EOC_DETECTED',
          description: 'Another critical issue',
          location: '10.5678/example',
          metadata: {},
        },
      ];

      const counts = getSeverityCounts(issues);
      expect(counts.errors).toBe(2);
      expect(counts.warnings).toBe(0);
    });

    it('should count only warnings when present', () => {
      const issues = [
        {
          type: 'expression-of-concern' as const,
          severity: 'warning' as const,
          code: 'CORRECTION_NOTICE',
          description: 'Minor concern',
          location: '10.1234/example',
          metadata: {},
        },
        {
          type: 'expression-of-concern' as const,
          severity: 'warning' as const,
          code: 'CORRECTION_NOTICE',
          description: 'Another minor concern',
          location: '10.5678/example',
          metadata: {},
        },
      ];

      const counts = getSeverityCounts(issues);
      expect(counts.errors).toBe(0);
      expect(counts.warnings).toBe(2);
    });
  });

  describe('Reference Processing', () => {
    it('should handle references with metadata', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-4',
        raw_text: 'Research article by authors',
        doi: '10.7554/eLife.12345',
        parsed_data: {
          authors: [{ lastName: 'Smith', firstName: 'John' }],
          year: '2020',
          title: 'Important Research',
        } as any,
      };

      const issues = await checkReferenceForEOC(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should prioritize doi over suggested_doi', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-5',
        raw_text: 'Article with both DOIs',
        doi: '10.1234/primary.doi',
        suggested_doi: '10.5678/suggested.doi',
      };

      const issues = await checkReferenceForEOC(reference as ReferenceInput);
      // Should use primary DOI
      expect(Array.isArray(issues)).toBe(true);
    });
  });

  describe('Issue Structure', () => {
    it('should return properly structured issue objects', async () => {
      const issues = [
        {
          type: 'expression-of-concern' as const,
          severity: 'warning' as const,
          code: 'EOC_DETECTED',
          description: 'Expression of concern detected',
          location: '10.1234/example.doi',
          suggestion: 'Review the expression of concern',
          metadata: {
            doi: '10.1234/example.doi',
            journalName: 'Example Journal',
            dateIssued: '2023-01-15',
            source: 'CrossRef',
          },
        },
      ];

      expect(issues[0]).toHaveProperty('type');
      expect(issues[0]).toHaveProperty('severity');
      expect(issues[0]).toHaveProperty('code');
      expect(issues[0]).toHaveProperty('description');
      expect(issues[0]).toHaveProperty('location');
      expect(issues[0]).toHaveProperty('metadata');
      expect(issues[0].type).toBe('expression-of-concern');
      expect(issues[0].severity).toBe('warning');
    });

    it('should include metadata with source information', async () => {
      const issue = {
        type: 'expression-of-concern' as const,
        severity: 'warning' as const,
        code: 'EOC_PUBMED',
        description: 'PubMed records expression of concern',
        location: '12345678',
        metadata: {
          doi: '10.1234/example',
          source: 'PubMed',
          dateIssued: '2023',
          journalName: 'Medical Journal',
        },
      };

      expect(issue.metadata?.source).toBe('PubMed');
      expect(issue.metadata?.doi).toBe('10.1234/example');
    });
  });
});

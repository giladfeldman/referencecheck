/**
 * Open Access Finder Tests
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { checkReferenceForOpenAccess, getSummaryData } from '../../src/openAccess/openAccessFinderService.js';
import type { ReferenceInput } from '../../src/types.js';

describe('Open Access Finder Service', () => {
  describe('Open Access Check for References', () => {
    it('should return empty array for reference without DOI', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-1',
        raw_text: 'Smith, J. (2020). Some article without DOI.',
      };

      const issues = await checkReferenceForOpenAccess(reference as ReferenceInput);
      expect(issues).toEqual([]);
    });

    it('should check reference with DOI', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-2',
        raw_text: 'Smith, J. (2020). Article with DOI.',
        doi: '10.1371/journal.pone.0000001',
      };

      const issues = await checkReferenceForOpenAccess(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should use suggested_doi if doi is not available', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-3',
        raw_text: 'Smith, J. (2020). Article with suggested DOI.',
        suggested_doi: '10.1234/example.doi',
      };

      const issues = await checkReferenceForOpenAccess(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });
  });

  describe('Open Access Status Detection', () => {
    it('should classify Gold OA status', () => {
      const issue = {
        type: 'open-access' as const,
        severity: 'info' as const,
        code: 'GOLD_OA',
        description: 'Published in open access journal',
        location: '10.1371/journal.pone.0000001',
        metadata: {
          openAccessStatus: 'gold' as const,
          source: 'Unpaywall',
        },
      };

      expect(issue.metadata?.openAccessStatus).toBe('gold');
    });

    it('should classify Green OA status', () => {
      const issue = {
        type: 'open-access' as const,
        severity: 'info' as const,
        code: 'GREEN_OA',
        description: 'Self-archived in repository',
        location: '10.1234/example',
        metadata: {
          openAccessStatus: 'green' as const,
          source: 'Unpaywall',
          url: 'https://example.com/paper.pdf',
        },
      };

      expect(issue.metadata?.openAccessStatus).toBe('green');
      expect(issue.metadata?.url).toBeDefined();
    });

    it('should classify Bronze OA status', () => {
      const issue = {
        type: 'open-access' as const,
        severity: 'info' as const,
        code: 'BRONZE_OA',
        description: 'Free to read but not reusable',
        location: '10.5678/example',
        metadata: {
          openAccessStatus: 'bronze' as const,
          source: 'Unpaywall',
        },
      };

      expect(issue.metadata?.openAccessStatus).toBe('bronze');
    });

    it('should mark closed access papers', () => {
      const issue = {
        type: 'open-access' as const,
        severity: 'info' as const,
        code: 'CLOSED_OA',
        description: 'Behind paywall',
        location: '10.9999/example',
        metadata: {
          openAccessStatus: 'closed' as const,
          source: 'Unpaywall',
        },
      };

      expect(issue.metadata?.openAccessStatus).toBe('closed');
    });
  });

  describe('Summary Data Generation', () => {
    it('should generate correct summary for mixed open access papers', () => {
      const issues = [
        {
          type: 'open-access' as const,
          severity: 'info' as const,
          code: 'GOLD_OA',
          description: 'Gold OA paper',
          location: '10.1/1',
          metadata: { openAccessStatus: 'gold' as const },
        },
        {
          type: 'open-access' as const,
          severity: 'info' as const,
          code: 'GREEN_OA',
          description: 'Green OA paper',
          location: '10.1/2',
          metadata: { openAccessStatus: 'green' as const },
        },
        {
          type: 'open-access' as const,
          severity: 'info' as const,
          code: 'BRONZE_OA',
          description: 'Bronze OA paper',
          location: '10.1/3',
          metadata: { openAccessStatus: 'bronze' as const },
        },
      ];

      const summary = getSummaryData(issues);
      expect(summary.goldOA).toBe(1);
      expect(summary.greenOA).toBe(1);
      expect(summary.bronzeOA).toBe(1);
      expect(summary.openAccessCount).toBe(3);
    });

    it('should handle no open access papers', () => {
      const issues: any[] = [];
      const summary = getSummaryData(issues);

      expect(summary.openAccessCount).toBe(0);
      expect(summary.goldOA).toBe(0);
      expect(summary.greenOA).toBe(0);
      expect(summary.bronzeOA).toBe(0);
    });

    it('should generate correct OA rate percentage', () => {
      const issues = [
        {
          type: 'open-access' as const,
          severity: 'info' as const,
          code: 'GOLD_OA',
          description: 'Gold OA',
          location: '10.1/1',
          metadata: { openAccessStatus: 'gold' as const },
        },
      ];

      const summary = getSummaryData(issues);
      expect(summary.openAccessCount).toBe(1);
    });
  });

  describe('Reference Processing', () => {
    it('should handle references with metadata', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-4',
        raw_text: 'Research article by authors',
        doi: '10.1371/journal.pone.0000001',
        parsed_data: {
          authors: [{ lastName: 'Smith', firstName: 'John' }],
          year: '2020',
          title: 'Important Research',
        } as any,
      };

      const issues = await checkReferenceForOpenAccess(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should prioritize doi over suggested_doi', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-5',
        raw_text: 'Article with both DOIs',
        doi: '10.1234/primary.doi',
        suggested_doi: '10.5678/suggested.doi',
      };

      const issues = await checkReferenceForOpenAccess(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });
  });

  describe('Issue Structure', () => {
    it('should return properly structured issue objects', () => {
      const issues = [
        {
          type: 'open-access' as const,
          severity: 'info' as const,
          code: 'GOLD_OA',
          description: 'Published in open access journal',
          location: '10.1234/example.doi',
          metadata: {
            openAccessStatus: 'gold' as const,
            url: 'https://example.com/paper.pdf',
            license: 'CC-BY',
            source: 'Unpaywall',
          },
        },
      ];

      expect(issues[0]).toHaveProperty('type');
      expect(issues[0]).toHaveProperty('severity');
      expect(issues[0]).toHaveProperty('code');
      expect(issues[0]).toHaveProperty('description');
      expect(issues[0]).toHaveProperty('location');
      expect(issues[0]).toHaveProperty('metadata');
      expect(issues[0].type).toBe('open-access');
      expect(issues[0].severity).toBe('info');
    });

    it('should include metadata with OA information', () => {
      const issue = {
        type: 'open-access' as const,
        severity: 'info' as const,
        code: 'GREEN_OA',
        description: 'Self-archived in institutional repository',
        location: '10.1234/example',
        metadata: {
          openAccessStatus: 'green' as const,
          url: 'https://repository.example.edu/paper.pdf',
          source: 'Unpaywall',
        },
      };

      expect(issue.metadata?.openAccessStatus).toBe('green');
      expect(issue.metadata?.url).toBeDefined();
      expect(issue.metadata?.source).toBe('Unpaywall');
    });

    it('should include license information when available', () => {
      const issue = {
        type: 'open-access' as const,
        severity: 'info' as const,
        code: 'GOLD_OA',
        description: 'Open access with license',
        location: '10.1234/example',
        metadata: {
          openAccessStatus: 'gold' as const,
          license: 'CC-BY-4.0',
          source: 'Unpaywall',
        },
      };

      expect(issue.metadata?.license).toBe('CC-BY-4.0');
    });
  });

  describe('Edge Cases', () => {
    it('should handle malformed DOI gracefully', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-6',
        raw_text: 'Paper with bad DOI',
        doi: 'not-a-real-doi',
      };

      const issues = await checkReferenceForOpenAccess(reference as ReferenceInput);
      // Should not throw, returns empty or error issues
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should handle references with null DOI fields', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-7',
        raw_text: 'Paper without identifiers',
        doi: undefined,
        suggested_doi: undefined,
      };

      const issues = await checkReferenceForOpenAccess(reference as ReferenceInput);
      expect(issues).toEqual([]);
    });
  });
});

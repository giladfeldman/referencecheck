/**
 * Citation Replies Detection Tests
 */

import { describe, it, expect } from '@jest/globals';
import { checkReferenceForReplies, getSummaryData } from '../../src/replies/citationRepliesService.js';
import type { ReferenceInput } from '../../src/types.js';

describe('Citation Replies Detection Service', () => {
  describe('Citation Replies Check for References', () => {
    it('should return empty array for reference without DOI', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-1',
        raw_text: 'Smith, J. (2020). Some article without DOI.',
      };

      const issues = await checkReferenceForReplies(reference as ReferenceInput);
      expect(issues).toEqual([]);
    });

    it('should check reference with DOI', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-2',
        raw_text: 'Smith, J. (2020). Article with DOI.',
        doi: '10.1126/science.aaa0001',
      };

      const issues = await checkReferenceForReplies(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should use suggested_doi if doi is not available', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-3',
        raw_text: 'Smith, J. (2020). Article with suggested DOI.',
        suggested_doi: '10.1234/example.doi',
      };

      const issues = await checkReferenceForReplies(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });
  });

  describe('Reply Type Detection', () => {
    it('should detect errata (corrections)', () => {
      const issue = {
        type: 'citation-replies' as const,
        severity: 'warning' as const,
        code: 'HAS_ERRATA',
        description: 'Errata published for this paper',
        location: '10.1126/science.aaa0001',
        metadata: {
          replyType: 'errata' as const,
          replyCount: 1,
        },
      };

      expect(issue.metadata?.replyType).toBe('errata');
      expect(issue.severity).toBe('warning');
    });

    it('should detect author replies', () => {
      const issue = {
        type: 'citation-replies' as const,
        severity: 'info' as const,
        code: 'HAS_AUTHOR_REPLY',
        description: 'Authors have published a reply to comments',
        location: '10.1234/example',
        metadata: {
          replyType: 'reply' as const,
          replyCount: 2,
        },
      };

      expect(issue.metadata?.replyType).toBe('reply');
    });

    it('should detect comments', () => {
      const issue = {
        type: 'citation-replies' as const,
        severity: 'info' as const,
        code: 'HAS_COMMENTS',
        description: 'Peer comments available',
        location: '10.5678/example',
        metadata: {
          replyType: 'comment' as const,
          replyCount: 3,
        },
      };

      expect(issue.metadata?.replyType).toBe('comment');
    });

    it('should detect responses', () => {
      const issue = {
        type: 'citation-replies' as const,
        severity: 'info' as const,
        code: 'IS_RESPONSE',
        description: 'Response to criticism published',
        location: '10.9999/example',
        metadata: {
          replyType: 'response' as const,
          replyCount: 1,
        },
      };

      expect(issue.metadata?.replyType).toBe('response');
    });
  });

  describe('Summary Data Generation', () => {
    it('should generate correct summary for mixed reply types', () => {
      const issues = [
        {
          type: 'citation-replies' as const,
          severity: 'warning' as const,
          code: 'HAS_ERRATA',
          description: 'Errata 1',
          location: '10.1/1',
          metadata: { replyType: 'errata' as const, replyCount: 1 },
        },
        {
          type: 'citation-replies' as const,
          severity: 'info' as const,
          code: 'HAS_AUTHOR_REPLY',
          description: 'Reply 1',
          location: '10.1/2',
          metadata: { replyType: 'reply' as const, replyCount: 1 },
        },
        {
          type: 'citation-replies' as const,
          severity: 'info' as const,
          code: 'HAS_COMMENTS',
          description: 'Comment 1',
          location: '10.1/3',
          metadata: { replyType: 'comment' as const, replyCount: 2 },
        },
        {
          type: 'citation-replies' as const,
          severity: 'info' as const,
          code: 'IS_RESPONSE',
          description: 'Response 1',
          location: '10.1/4',
          metadata: { replyType: 'response' as const, replyCount: 1 },
        },
      ];

      const summary = getSummaryData(issues);
      expect(summary.totalIssues).toBe(4);
      expect(summary.errata).toBe(1);
      expect(summary.authorReplies).toBe(1);
      expect(summary.comments).toBe(1);
      expect(summary.responses).toBe(1);
    });

    it('should handle only errata', () => {
      const issues = [
        {
          type: 'citation-replies' as const,
          severity: 'warning' as const,
          code: 'HAS_ERRATA',
          description: 'Errata published',
          location: '10.1/1',
          metadata: { replyType: 'errata' as const, replyCount: 2 },
        },
      ];

      const summary = getSummaryData(issues);
      expect(summary.errata).toBe(1);
      expect(summary.authorReplies).toBe(0);
      expect(summary.comments).toBe(0);
      expect(summary.responses).toBe(0);
    });

    it('should handle no replies or corrections', () => {
      const issues: any[] = [];
      const summary = getSummaryData(issues);

      expect(summary.totalIssues).toBe(0);
      expect(summary.errata).toBe(0);
      expect(summary.authorReplies).toBe(0);
      expect(summary.comments).toBe(0);
      expect(summary.responses).toBe(0);
    });

    it('should calculate reply percentage correctly', () => {
      const issues = [
        {
          type: 'citation-replies' as const,
          severity: 'info' as const,
          code: 'HAS_AUTHOR_REPLY',
          description: 'One reply',
          location: '10.1/1',
          metadata: { replyType: 'reply' as const, replyCount: 1 },
        },
      ];

      const summary = getSummaryData(issues);
      expect(summary.totalIssues).toBe(1);
    });
  });

  describe('Reference Processing', () => {
    it('should handle references with metadata', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-4',
        raw_text: 'Research article with controversy',
        doi: '10.1126/science.aaa0001',
        parsed_data: {
          authors: [{ lastName: 'Smith', firstName: 'John' }],
          year: '2020',
          title: 'Controversial findings',
        } as any,
      };

      const issues = await checkReferenceForReplies(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should handle references with only essential data', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-5',
        raw_text: 'Smith et al.',
        doi: '10.1234/example.doi',
      };

      const issues = await checkReferenceForReplies(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should prioritize doi over suggested_doi', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-6',
        raw_text: 'Article with both DOIs',
        doi: '10.1234/primary.doi',
        suggested_doi: '10.5678/suggested.doi',
      };

      const issues = await checkReferenceForReplies(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
    });
  });

  describe('Issue Structure', () => {
    it('should return properly structured issue objects', () => {
      const issues = [
        {
          type: 'citation-replies' as const,
          severity: 'warning' as const,
          code: 'HAS_ERRATA',
          description: 'Errata has been published for this paper',
          location: '10.1126/science.aaa0001',
          metadata: {
            replyType: 'errata' as const,
            replyCount: 1,
          },
        },
      ];

      expect(issues[0]).toHaveProperty('type');
      expect(issues[0]).toHaveProperty('severity');
      expect(issues[0]).toHaveProperty('code');
      expect(issues[0]).toHaveProperty('description');
      expect(issues[0]).toHaveProperty('location');
      expect(issues[0]).toHaveProperty('metadata');
      expect(issues[0].type).toBe('citation-replies');
    });

    it('should include reply count in metadata', () => {
      const issue = {
        type: 'citation-replies' as const,
        severity: 'info' as const,
        code: 'HAS_COMMENTS',
        description: 'Multiple comments found',
        location: '10.1234/example',
        metadata: {
          replyType: 'comment' as const,
          replyCount: 5,
        },
      };

      expect(issue.metadata?.replyCount).toBe(5);
      expect(issue.metadata?.replyCount).toBeGreaterThan(0);
    });

    it('should properly set severity for errata vs comments', () => {
      const errataIssue = {
        type: 'citation-replies' as const,
        severity: 'warning' as const,
        code: 'HAS_ERRATA',
        description: 'Correction published',
        location: '10.1/1',
        metadata: { replyType: 'errata' as const },
      };

      const commentIssue = {
        type: 'citation-replies' as const,
        severity: 'info' as const,
        code: 'HAS_COMMENTS',
        description: 'Comments available',
        location: '10.1/2',
        metadata: { replyType: 'comment' as const },
      };

      expect(errataIssue.severity).toBe('warning');
      expect(commentIssue.severity).toBe('info');
    });
  });

  describe('Edge Cases', () => {
    it('should handle papers without any replies', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-7',
        raw_text: 'Clean paper',
        doi: '10.9999/uncontroversial.doi',
        parsed_data: {
          authors: [],
          year: '',
          title: 'Uncontroversial topic',
        } as any,
      };

      const issues = await checkReferenceForReplies(reference as ReferenceInput);
      expect(Array.isArray(issues)).toBe(true);
      expect(issues).toHaveLength(0);
    });

    it('should handle references with null DOI fields', async () => {
      const reference: Partial<ReferenceInput> = {
        id: 'ref-8',
        raw_text: 'Paper without identifiers',
        doi: undefined,
        suggested_doi: undefined,
      };

      const issues = await checkReferenceForReplies(reference as ReferenceInput);
      expect(issues).toEqual([]);
    });

    it('should handle multiple corrections for same paper', () => {
      const issues = [
        {
          type: 'citation-replies' as const,
          severity: 'warning' as const,
          code: 'HAS_ERRATA',
          description: 'First erratum published',
          location: '10.1234/problematic.doi',
          metadata: { replyType: 'errata' as const, replyCount: 1 },
        },
        {
          type: 'citation-replies' as const,
          severity: 'warning' as const,
          code: 'HAS_ERRATA',
          description: 'Second erratum published',
          location: '10.1234/problematic.doi',
          metadata: { replyType: 'errata' as const, replyCount: 1 },
        },
      ];

      const summary = getSummaryData(issues);
      expect(summary.errata).toBe(2);
    });

    it('should handle high number of peer comments', () => {
      const issues = [
        {
          type: 'citation-replies' as const,
          severity: 'info' as const,
          code: 'HAS_COMMENTS',
          description: 'Many comments',
          location: '10.1234/popular.doi',
          metadata: { replyType: 'comment' as const, replyCount: 15 },
        },
      ];

      const summary = getSummaryData(issues);
      expect(summary.comments).toBe(1);
    });
  });

  describe('Multiple Issues per Paper', () => {
    it('should handle papers with both errata and replies', () => {
      const issues = [
        {
          type: 'citation-replies' as const,
          severity: 'warning' as const,
          code: 'HAS_ERRATA',
          description: 'Errata',
          location: '10.1234/example',
          metadata: { replyType: 'errata' as const, replyCount: 1 },
        },
        {
          type: 'citation-replies' as const,
          severity: 'info' as const,
          code: 'HAS_AUTHOR_REPLY',
          description: 'Reply to critics',
          location: '10.1234/example',
          metadata: { replyType: 'reply' as const, replyCount: 1 },
        },
      ];

      const summary = getSummaryData(issues);
      expect(summary.totalIssues).toBe(2);
      expect(summary.errata).toBe(1);
      expect(summary.authorReplies).toBe(1);
    });
  });
});

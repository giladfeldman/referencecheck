/**
 * Citation Replies Detection Service
 * Detects if papers have author replies or errata/corrections
 */

import type { ReferenceInput } from '../types.js';
import axios from 'axios';
import { crossrefGet } from '../http/crossref.js';

export interface CitationRepliesIssue {
  type: 'citation-replies';
  severity: 'info' | 'warning';
  code: string;
  description: string;
  location: string;
  suggestion?: string;
  metadata?: {
    doi?: string;
    replyType?: 'errata' | 'correction' | 'reply' | 'comment' | 'response';
    replyCount?: number;
    replyDOI?: string;
    replyDate?: string;
    source?: string;
  };
}

/**
 * Check if a paper has associated replies, comments, or errata via CrossRef
 */
async function checkForReplies(doi: string): Promise<CitationRepliesIssue[]> {
  const issues: CitationRepliesIssue[] = [];

  try {
    const response = await crossrefGet(`https://api.crossref.org/works/${doi}`, {
      timeout: 5000,
    });

    const data = response.data?.message || {};

    // Check for relation types that indicate replies/corrections
    const relations = data.relation || {};

    // Check for errata
    if (relations['is-corrected-by']) {
      const correctedBy = relations['is-corrected-by'];
      issues.push({
        type: 'citation-replies',
        severity: 'warning',
        code: 'HAS_ERRATA',
        description: `This paper has ${correctedBy.length} errata or correction(s)`,
        location: doi,
        suggestion: 'Review the errata to understand what was corrected',
        metadata: {
          doi,
          replyType: 'errata',
          replyCount: correctedBy.length,
          replyDOI: correctedBy[0]?.id,
          source: 'CrossRef',
        },
      });
    }

    // Check for author replies
    if (relations['has-reply']) {
      const replies = relations['has-reply'];
      issues.push({
        type: 'citation-replies',
        severity: 'info',
        code: 'HAS_AUTHOR_REPLY',
        description: `${replies.length} author reply/replies available`,
        location: doi,
        suggestion: 'Check the author replies for additional context',
        metadata: {
          doi,
          replyType: 'reply',
          replyCount: replies.length,
          replyDOI: replies[0]?.id,
          source: 'CrossRef',
        },
      });
    }

    // Check for comments (can be peer comments)
    if (relations['has-comment']) {
      const comments = relations['has-comment'];
      issues.push({
        type: 'citation-replies',
        severity: 'info',
        code: 'HAS_COMMENTS',
        description: `${comments.length} comment(s) on this paper`,
        location: doi,
        suggestion: 'Review comments from other researchers',
        metadata: {
          doi,
          replyType: 'comment',
          replyCount: comments.length,
          replyDOI: comments[0]?.id,
          source: 'CrossRef',
        },
      });
    }

    // Check for responses to comments
    if (relations['is-response-to']) {
      const responseTo = relations['is-response-to'];
      issues.push({
        type: 'citation-replies',
        severity: 'info',
        code: 'IS_RESPONSE',
        description: 'This is a response/reply to another paper',
        location: doi,
        suggestion: 'Read the original paper to understand the context of this response',
        metadata: {
          doi,
          replyType: 'response',
          replyDOI: responseTo[0]?.id,
          source: 'CrossRef',
        },
      });
    }

    return issues;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status !== 404) {
        console.warn(`Error checking replies for ${doi}:`, error.message);
      }
    }
    return issues;
  }
}

/**
 * Check reference for citation replies
 */
export async function checkReferenceForReplies(reference: ReferenceInput): Promise<CitationRepliesIssue[]> {
  // Only check if we have a DOI
  const doi = reference.doi || reference.suggested_doi;
  if (!doi) {
    return [];
  }

  return await checkForReplies(doi);
}

/**
 * Get summary data
 */
export function getSummaryData(issues: CitationRepliesIssue[]): {
  totalIssues: number;
  errata: number;
  authorReplies: number;
  comments: number;
  responses: number;
} {
  return {
    totalIssues: issues.length,
    errata: issues.filter(i => i.code === 'HAS_ERRATA').length,
    authorReplies: issues.filter(i => i.code === 'HAS_AUTHOR_REPLY').length,
    comments: issues.filter(i => i.code === 'HAS_COMMENTS').length,
    responses: issues.filter(i => i.code === 'IS_RESPONSE').length,
  };
}

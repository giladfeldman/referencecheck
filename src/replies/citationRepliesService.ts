/**
 * Citation Replies Detection Service
 * Detects if papers have author replies or errata/corrections
 */

import type { ReferenceInput } from '../types.js';
import axios from 'axios';
import { crossrefGet } from '../http/crossref.js';
import { cleanDoiInput, formatDateParts } from '../util/normalize.js';

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
    const response = await crossrefGet(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      timeout: 5000,
    });

    const data = response.data?.message || {};

    // Replies and comments are Crossref relations (`has-reply`, `has-comment`,
    // `is-reply-to`). Corrections are NOT a relation: Crossref serves them in
    // `updated-by`, like retractions. Before 0.3.0 this read `is-corrected-by` and
    // `is-response-to`, which Crossref rejects as relation types (measured
    // 2026-11-18), so HAS_ERRATA and IS_RESPONSE could never fire.
    const relations = data.relation || {};

    // Not `addendum` or `clarification`: they add material and correct nothing.
    const CORRECTION_TYPES = new Set(['correction', 'erratum', 'corrigendum']);
    const correctedBy = (Array.isArray(data['updated-by']) ? data['updated-by'] : []).filter(
      (u: any) => typeof u?.type === 'string' && CORRECTION_TYPES.has(u.type.toLowerCase()),
    );
    // One notice per DOI however it is written (case, resolver URL), and never the work
    // itself: a record listing only its own DOI as its correction has no errata (review
    // 2026-11-19). A notice with no DOI still counts, once each.
    const ownKey = cleanDoiInput(doi).toLowerCase();
    const seen = new Set<string>();
    const notices: any[] = [];
    for (const u of correctedBy) {
      const key = cleanDoiInput(u?.DOI).toLowerCase();
      if (key && (key === ownKey || seen.has(key))) continue;
      if (key) seen.add(key);
      notices.push(u);
    }
    const correctionDois = notices.map((u: any) => cleanDoiInput(u?.DOI)).filter(Boolean);

    // Check for errata
    if (notices.length > 0) {
      const earliest = notices
        .map((u: any) => formatDateParts(u?.updated?.['date-parts']?.[0]))
        .filter(Boolean)
        .sort()[0];
      issues.push({
        type: 'citation-replies',
        severity: 'warning',
        code: 'HAS_ERRATA',
        description: `This paper has ${notices.length} errata or correction(s)`,
        location: doi,
        suggestion: 'Review the errata to understand what was corrected',
        metadata: {
          doi,
          replyType: 'errata',
          replyCount: notices.length,
          replyDOI: correctionDois[0] as string | undefined,
          replyDate: earliest,
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
    if (relations['is-reply-to']) {
      const responseTo = relations['is-reply-to'];
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
  const doi = cleanDoiInput(reference.doi || reference.suggested_doi);
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

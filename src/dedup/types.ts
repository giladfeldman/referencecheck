import type { ReferenceInput } from '../types.js';

export interface DuplicatePair {
  ref1: ReferenceInput;
  ref2: ReferenceInput;
  similarity: number;
}

export interface DuplicateGroup {
  references: ReferenceInput[];
  bestReference: ReferenceInput;
  averageSimilarity: number;
}

export interface DeduplicationConfig {
  threshold: number;
  authorWeighting: number;
  titleWeighting: number;
}

export interface DeduplicationIssue {
  severity: 'warning';
  type: 'duplicate-reference';
  description: string;
  references: Array<{
    id: string;
    title: string;
    authors: string;
    year: number | null;
    metadata_completeness: number;
  }>;
  similarity: number;
  suggestion: string;
}

export interface DeduplicationResults {
  success: boolean;
  issues: DeduplicationIssue[];
  summary: {
    totalReferences: number;
    duplicatePairs: number;
    duplicateGroups: number;
    referencesAffected: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

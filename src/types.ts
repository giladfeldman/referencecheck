/**
 * Structural reference-input types for referencecheck.
 *
 * referencecheck never imports @scimeto/shared. These interfaces are a
 * minimal STRUCTURAL SUBSET of Scimeto's `Reference` DB-entity type —
 * only the fields the library's functions actually read. Any Scimeto
 * `Reference` row satisfies `ReferenceInput` by TypeScript structural typing,
 * so the worker adapter layer passes its DB rows directly with no mapping.
 *
 * Field membership was verified by reading every extracted function during
 * the Wave 3 extraction. Do not add fields the library does not read.
 */

/** Parsed-reference subset — the fields predatory/dedup read off parsed_data. */
export interface ParsedReferenceInput {
  authors?: unknown[];
  year?: string;
  title?: string;
  source?: string;
  volume?: string;
  pages?: string;
}

/**
 * The structural reference shape the referencecheck functions consume.
 * Every field is optional except `id` and `raw_text` — `raw_text` is non-null
 * in the Scimeto schema and the predatory `isValidReference` /
 * `extractJournalMetadata` functions read it unconditionally.
 */
export interface ReferenceInput {
  id: string;
  raw_text: string;
  doi?: string;
  suggested_doi?: string;
  doi_crossref_data?: any;
  parsed_data?: ParsedReferenceInput;
  normalized_authors?: string[];
  normalized_title?: string;
  normalized_year?: string;
  url?: string;
  journal_validation_checked_at?: string;
}

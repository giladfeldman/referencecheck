// Types for rows.mjs (plain JavaScript so any build, including 0.2.x, can be scored with it).
export interface LabelledRow {
  kind: 'dedup' | 'doi';
  cls: string;
  label: 'same' | 'different' | 'accept' | 'reject';
  note: string;
  a?: any;
  b?: any;
  text?: string;
  candidate?: any;
}
export interface ScoredRow {
  row: LabelledRow;
  decision: 'same' | 'different' | 'accept' | 'reject';
  ok: boolean;
  score?: number;
  result?: any;
}
export interface ClassTally {
  rows: number;
  falseMerges: number;
  missedMerges: number;
  wrongAccepts: number;
  rightRejects: number;
}
export const DEDUP_CONFIG: { threshold: number; authorWeighting: number; titleWeighting: number };
export const ROWS: { dedup: LabelledRow[]; doi: LabelledRow[] };
export const MEASURES: Array<'falseMerges' | 'missedMerges' | 'wrongAccepts' | 'rightRejects'>;
export function scoreRows(lib: any, setSearchItems: (items: any[]) => void): Promise<ScoredRow[]>;
export function tally(results: ScoredRow[]): Record<string, ClassTally>;

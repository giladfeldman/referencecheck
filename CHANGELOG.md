# Changelog

## 0.1.1 — 2026-06-08

Deterministic-core hardening (via `citationguard-iterate`). The pure-logic core
(DOI shape, Beall's matching, dedup similarity, reference validation) previously
had **zero** standalone test coverage; this release fixes three correctness bugs
and adds 37 unit tests. Suite 75 → 112.

### Fixed
- **Predatory false positive (D3, integrity-critical).** `checkBeallsList` /
  `isKnownLegitimate` used raw substring matching (`a.includes(b) || b.includes(a)`),
  so a legitimate publisher was branded predatory on a partial-word overlap —
  e.g. "SciTechnology Publications" matched the Beall's entry "SciTechnol". Now
  uses whole-word, order-preserving token-sequence containment with a
  generic-word guard, preserving distinctive single-word and short-form matches
  while eliminating partial-word hits.
- **Whitespace / Unicode in publisher matching (D4).** Folded into the D3 fix:
  tokenization collapses irregular whitespace and keeps accented / non-Latin
  letters instead of relying on exact substring equality.
- **Asymmetric author similarity (D9).** `compareAuthors` averaged best-matches
  over the first list only, so `compareAuthors(a, b) !== compareAuthors(b, a)`
  whenever the lists differed in length — making dedup similarity depend on pair
  ordering. Now averages both directions (commutative).
- **Non-Latin author detection (D6).** `isValidReference`'s author-pattern
  fallback regex was ASCII + Latin-1 only; Cyrillic / Greek-authored references
  lost their "author" indicator. Now Unicode-aware (`\p{Lu}`/`\p{Ll}`).

### Notes (triaged, intentionally unchanged)
- `crossref.ts` final `return` is reachable for the TypeScript control-flow
  analyzer (nested try/catch + rethrow) — kept, not dead code.
- `selectBestReference` throwing on an empty array is intended defensive
  behavior; its only caller guards `length > 1`. Documented with a contract test.
- `doi/doiShape.ts` is a deliberate verbatim copy of the worker's
  `entityOwnership.ts` helpers — behavior-pinned with tests, not modified.

## 0.1.0

- Initial behavior-preserving extraction from the CitationGuard platform.

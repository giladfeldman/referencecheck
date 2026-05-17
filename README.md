# referencecheck

Reference-integrity checks for academic papers: DOI validation against
Crossref, retraction detection (OpenRetractions + Crossref), predatory-journal
screening (Beall's List + DOAJ + OpenAlex + heuristics), reference
deduplication (fuzzy author/title/year matching), citation-count lookup
(OpenCitations), and open-access / preprint / expression-of-concern /
citation-replies detection.

Pure logic + HTTP clients — no database, no app framework, no plugin
lifecycle. Credentials (polite-pool contact emails) are passed in as
parameters; the library never reads environment variables. The predatory
publisher registry (Beall's List) is bundled.

Extracted from the CitationGuard platform so the community can validate and
reuse it. Status: 0.1.0, behavior-preserving extraction; accuracy iteration is
ongoing.

## API

- `validateDOI(doi, creds?)` / `findDOIFromReference(text, creds?)` — Crossref DOI validation + lookup
- `checkRetraction(doi)` / `checkMultipleRetractions(dois)` — retraction detection
- `getCitationCount(doi)` / `getCitingWorks(doi)` — OpenCitations citation data
- `checkReferenceForOpenAccess(ref)` — Unpaywall open-access detection
- `checkReferenceForPreprint(ref)` — preprint detection (heuristic + Crossref)
- `checkReferenceForEOC(ref)` — expression-of-concern detection
- `checkReferenceForReplies(ref)` — errata / reply / comment detection
- `loadBeallsList()` / `checkBeallsList(publisher)` / `checkHeuristics(...)` / `determineVerdict(...)` / `extractJournalMetadata(ref, useOpenAlex?, creds?)` — predatory-journal screening pieces
- `calculateSimilarity(ref1, ref2, config)` / `findDuplicateGroups(pairs)` / `scoreMetadataCompleteness(ref)` — reference-deduplication pieces
- `isMalformedDoi(doi)` / `isShortFormDoi(doi)` — DOI-shape validation
- All result/config types and the structural reference-input interfaces

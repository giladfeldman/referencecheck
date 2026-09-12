# referencecheck

Reference-integrity checks for academic papers: DOI validation against
Crossref, retraction detection (Crossref `updated-by` relations, which relay
Retraction Watch data; OpenRetractions opt-in), predatory-journal
screening (Beall's List + DOAJ + OpenAlex + heuristics), reference
deduplication (fuzzy author/title/year matching), citation-count lookup
(OpenCitations), and open-access / preprint / expression-of-concern /
citation-replies detection.

Pure logic + HTTP clients — no database, no app framework, no plugin
lifecycle. Credentials (polite-pool contact emails) are passed in as
parameters; the library never reads environment variables. The predatory
publisher registry (Beall's List) is bundled.

Extracted from the Scimeto platform so the community can validate and
reuse it. Accuracy iteration is ongoing — see [CHANGELOG.md](./CHANGELOG.md) and
the [release tags](https://github.com/giladfeldman/referencecheck/tags) for the
current version. (No version is quoted here on purpose; a hardcoded one goes
stale silently.)

## Install

**Distributed as a git-tag dependency, not via npm.** This package is
deliberately not published to the npm registry. Pin a tag directly:

```jsonc
// package.json
"dependencies": {
  "referencecheck": "github:giladfeldman/referencecheck#v0.1.1"
}
```

npm clones the repo and runs the `prepare` script, which builds `dist/` — a tag
pin installs a working build with no registry involved. The `files` field in
`package.json` is standard packaging metadata kept ready for a possible future
publish; it has no effect on the git-tag install path.

Always pin an explicit tag. A bare `github:giladfeldman/referencecheck` floats on
the default branch, so upstream changes land in your build silently.

## API

- `validateDOI(doi, creds?)` / `findDOIFromReference(text, creds?)` — Crossref DOI validation + lookup
- `checkRetraction(doi, options?)` / `checkRetractionDetailed(doi, options?)` / `checkMultipleRetractions(dois, options?)` — retraction detection. `options` takes `creds` (Crossref polite-pool contact) and `sources` (defaults to `DEFAULT_RETRACTION_SOURCES`, which is Crossref alone — see the 0.1.4 CHANGELOG entry for why OpenRetractions is opt-in). Prefer `checkRetractionDetailed` anywhere the result reaches a reader: its `complete` flag is false whenever a source went unread, so "not retracted" is never confused with "could not check". `isRetracted` means "pulled from the literature — do not cite as an ordinary reference" and covers retraction, partial retraction, removal and withdrawal; **read `retractionType` before using the word "retracted" in anything a person reads**, because a withdrawn preprint is not a retracted paper.
- `getCitationCount(doi)` / `getCitingWorks(doi)` — OpenCitations citation data
- `checkReferenceForOpenAccess(ref)` — Unpaywall open-access detection
- `checkReferenceForPreprint(ref)` — preprint detection (heuristic + Crossref)
- `checkReferenceForEOC(ref)` — expression-of-concern detection
- `checkReferenceForReplies(ref)` — errata / reply / comment detection
- `loadBeallsList()` / `checkBeallsList(publisher)` / `checkHeuristics(...)` / `determineVerdict(...)` / `extractJournalMetadata(ref, useOpenAlex?, creds?)` — predatory-journal screening pieces
- `calculateSimilarity(ref1, ref2, config)` / `findDuplicateGroups(pairs)` / `scoreMetadataCompleteness(ref)` — reference-deduplication pieces
- `isMalformedDoi(doi)` / `isShortFormDoi(doi)` — DOI-shape validation
- All result/config types and the structural reference-input interfaces

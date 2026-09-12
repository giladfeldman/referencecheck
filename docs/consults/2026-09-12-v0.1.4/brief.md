# Consult brief — referencecheck v0.1.4 retraction checker

**Repo:** `<repo root>`
**Commit under review:** `91d11c8` (tip of `main`, tree frozen)
**Primary file:** `src/retraction/retractionChecker.ts`
**Tests:** `tests/retraction/retractionCoverage.test.ts`, `tests/retraction/retractionDetection.test.ts`
**Fixtures:** `tests/fixtures/crossref/*.json` (verbatim recorded Crossref bodies), `tests/fixtures/crossrefFixture.ts`

Read these files directly. Do not rely on this brief's description of them.

## What this code does and why being wrong is expensive

This library is consumed in production by **Scimeto**, a scientific-integrity platform that
tells paper authors whether the references they cite have been retracted. The result is shown
in a web app and exported into HTML and Word reports that authors act on.

The failure mode is **not a crash**. It is a plausible, confident, wrong answer that no test
catches. Two directions, both of which reach a researcher:

- a **false clean** — a retracted reference reported fine; nobody ever looks again;
- a **false positive** — a healthy reference reported retracted; the author removes or
  distrusts a good citation.

## What changed in v0.1.4

The previous release read `message.update` from the Crossref work record. That field does not
exist in Crossref's response. The field that does is `message['updated-by']`. So the predicate
could never fire, and the only surviving Crossref detection was a title substring match. The
test suite stayed green because the fixture was hand-built and injected the fictional field.

Measured through the compiled library against the live Crossref API on 2026-09-12, v0.1.3 got
four of six DOIs wrong and reported `complete: true` on every one. v0.1.4 gets six of six right.

v0.1.4 changes:

1. Detection reads `message['updated-by']`, selecting the entry by `type === 'retraction'`
   (falling back to a label containing "retract"), rather than by position — a retracted paper
   commonly carries corrections alongside the retraction.
2. `update-to` is deliberately NOT read as evidence about the queried DOI.
3. The title heuristic became a case-sensitive prefix `/^\s*(?:RETRACTED|WITHDRAWN)\b/`,
   replacing `title.toLowerCase().includes('retract')`.
4. The `message.type === 'retraction'` branch was deleted as dead code.
5. `checked` and `complete` are both `sourcesUnavailable.length === 0`.
6. OpenRetractions was removed from the DEFAULT source list (still available via
   `options.sources`), because its host does not resolve.
7. `creds` (Crossref polite-pool contact) is threaded through to `crossrefGet`.

## Measurements already taken (verify or refute these — do not assume them)

- `message.update` was `undefined` on every DOI tested, retracted and healthy alike.
- `message['updated-by']` entries carry `source: "retraction-watch"`.
- On a 14-work corpus of genuinely retracted papers drawn from Crossref's own
  `filter=update-type:retraction`, `updated-by` carried a retraction entry on **14 of 14**;
  a capitalised `RETRACTED`/`WITHDRAWN` title prefix appeared on only **9 of 14**.
- A Crossref search for meta-science papers *about* retraction returned **8 of 8** healthy
  papers whose titles contain "retract" (e.g. "Retracted Publications in Indian Science:
  Reasons and Institutions", DOI `10.57656/sc-2025-0013`).
- The LaCour retraction notice `10.1126/science.aac6638` carries `update-to` pointing at the
  retracted paper, and no `updated-by`.
- `filter=type:retraction` returns HTTP 400 while `filter=type:journal-article` returns 200;
  the `/types` registry contains no `retraction` id.
- `api.openretractions.com` and `openretractions.com` both returned `EAI_AGAIN` on DNS lookup
  while `api.crossref.org` resolved on the same call (2026-09-12).

## Questions

1. **Is reading `updated-by` and selecting by `type === 'retraction'` correct AND complete for
   Crossref?** Are there other shapes a Crossref retraction can take that this misses —
   different `type` values, `assertion`, `relation` keys, partial/withdrawn variants, records
   where the retraction is only on the notice side? Is it right to NOT read `update-to` as
   evidence the *queried* DOI was retracted?

2. **Will the case-sensitive `/^\s*(?:RETRACTED|WITHDRAWN)\b/` title fallback produce false
   negatives or false positives on real publisher titles?** Consider titles beginning with
   HTML/entity markup, leading quotes or brackets, non-ASCII dashes, "Retracted:" in title
   case, "WITHDRAWN" used for a withdrawn preprint that was never retracted, and titles where
   the marker is a suffix rather than a prefix. Note the fixture
   `retracted-caps-title.json`-adjacent record `10.4236/fns.2013.46a006` has a title beginning
   `RETRACTED: &amp;lt;i&amp;gt;…`.

3. **Is dropping OpenRetractions from the defaults sound, and do `checked` and `complete`
   correctly separate verdict from coverage?** Specifically: is it defensible that a caller
   passing no options now gets `complete: true` from a single source? Is there a case where
   `sourcesChecked` is populated but the answer should still not be trusted? Does any code path
   push to `sourcesChecked` or `sourcesUnavailable` incorrectly — in particular the non-200
   response path, and the 404-is-an-answer branch?

4. **Name any concrete way a false CLEAN or a false RETRACTED can still reach a caller.** Give
   the input that produces it. This is the question that matters most.

5. Anything in the tests that asserts the implementation rather than the behaviour, or any
   fixture whose realism you doubt.

## Ground rules

- **"Findings: 0" is a legitimate answer.** Do not manufacture findings to look useful. But say
  explicitly which of the five questions you actually checked against the code.
- Quote `file:line` and the verbatim line for every finding.
- For each recommendation, state **what measurement would refute it**. An assertion about
  Crossref's behaviour that you did not verify against a real record is a hypothesis; label it
  one.
- Do not modify any file. This is read-only review.

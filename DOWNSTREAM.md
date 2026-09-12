# Downstream — who consumes this library

**This library is not standalone infrastructure. It is part of a product.**

## Consumer: Scimeto

- **Consumer:** the Scimeto platform (closed source)
- **Pinned in:** `apps/worker/package.json` **and** `apps/api/package.json`, by **git tag**
  (`github:giladfeldman/referencecheck#vX.Y.Z`). **Two manifests, not one** — a bump that
  updates one and not the other leaves two different versions of this library running in
  one product, and no test on either side notices. The worker performs the overwhelming
  majority of the checks.
- **Uses:** DOI validation, retraction, expression of concern, open access, predatory journal, preprint, deduplication and citation replies
- **Reaches users through:** the doi, retraction, expression-of-concern, open-access, predatory-journal, preprint, deduplication and citation-replies processors, whose output is shown to researchers
  as findings about their manuscript and exported into reports they act on.

Scimeto's side of this relationship is documented on the consumer side, and the two
are checked against each other mechanically by a sync check there, which fails if this
file goes missing or stops naming Scimeto.

## What that means for a change here

Scimeto is a **scientific-integrity platform**. Its failure mode is not a crash — it is
a plausible, confident, wrong answer that no test catches: a green badge on a manuscript
with real findings, a count that is silently zero, an all-clear over a check that never
ran. A defect in this library becomes exactly that, and it reaches a researcher.

So:

1. **A test watched failing against the defect first.** Break the fix and see it go red
   before trusting it. A test written after the fix that re-asserts current behaviour
   proves nothing.
2. **A failure mode the return type cannot express is a bug in the type.** If a caller
   cannot distinguish "checked, clean" from "could not check", it will report the
   former — and it will be wrong in the direction that matters.
3. **Offline tests for failure modes.** Suites that hit live APIs cannot express
   "and now the upstream rate-limits you". Mock the transport.
4. **A fixture must be a recorded response, not a hand-built one.** A synthetic fixture
   cannot tell you the rule is wrong, only that your fixture is — and a test built on one
   keeps the suite green over code that cannot run. The recorded Crossref bodies live in
   `tests/fixtures/crossref/`, with the script that captures them from the live API.
5. **Every detector needs a calibration case its fallback cannot pass.** Retraction
   detection is proven on a retracted paper whose title says nothing about retraction.
   Without such a case, a detector that has quietly degraded to its weakest heuristic
   looks exactly like a working one.
6. **Check the false-positive direction too.** A false clean hides a retracted reference;
   a false positive tells an author a good reference is retracted. Both reach a
   researcher, and only the first one gets looked for.

### Precedent: green tests over code that could not run (v0.1.4, 2026-09-12)

`v0.1.3` added the coverage flags this file asks for — and added them over Crossref
detection code that could never fire. It read `message.update`; Crossref serves
`message['updated-by']`. The library's own test hard-coded the fictional field, so the
suite was green, the CHANGELOG was confident, and the only retraction Scimeto could
still detect was one whose title literally began "RETRACTED:".

Measured through the compiled library against the live API on 2026-09-12, over six DOIs:
**v0.1.3 got four wrong and reported `complete: true` on every one** — two retracted
papers reported clean (including LaCour & Green 2014), and two healthy works reported
retracted (a 2025 paper *about* retraction, and a retraction notice itself).

Rules 4 and 5 above come out of this.

And a false clean is not the only failure that reaches a researcher: a **false positive**
tells a paper author that a perfectly good reference is retracted. Meta-science
bibliographies are full of papers about retraction — 8 of 8 in a Crossref search — and
v0.1.3 flagged all of them.

### Precedent: a library defect that looked like a consumer defect

`v0.1.2` (2026-08-21) fixed one worth remembering. Every EOC source function returned
`Issue | null`, and `null` meant *no expression of concern*, *DOI not found*, *429*,
*5xx* and *timeout* alike. Scimeto could not tell "we asked and there is nothing" from
"we never got an answer", so a Crossref rate-limit storm reported an entire bibliography
clean. Measured downstream: one real run logged **81 Crossref 429s** while the plugin
recorded `outcome: completed, issuesFound: 0, referencesChecked: 56`.

The consumer could not fix it. Any coverage figure it computed would have been derived
from information this library did not return — the same defect, one layer up. **When a
return type cannot express a failure mode, that is a library bug, and the fix belongs
here.**

## Releasing

The pin downstream resolves a **TAG**. A commit on `main` with no tag changes nothing
for Scimeto, and Railway installs from the tag, so a local path or branch override will
pass locally and fail on deploy.

1. test → `npm run build` → `npm test`
2. bump `package.json`, add a **CHANGELOG** entry naming the defect, the evidence, and
   what a consumer must now do differently
3. commit, `git tag vX.Y.Z`, **push the tag**
4. in Scimeto: bump the pin in *every* manifest that declares it — grep the repo for
   `referencecheck` rather than trusting this list, then **`npm update referencecheck` — not
   `npm install`**. `npm install` rewrites the spec line but can leave the lockfile's
   `resolved` field on the previous commit, so the pin reads as bumped while the
   installed code is the old one. Verify it landed by checking that each lockfile's
   `resolved` sha equals `git rev-parse vX.Y.Z^{}` from this repo. Then update the
   consumer to actually use what the release added, and run `npm run verify`
5. deploy Scimeto — a released fix nobody deployed is a fix nobody has

Step 4's "actually use it" is not optional bookkeeping: a capability no call site
invokes is not shipped, and the library's own tests pass either way.

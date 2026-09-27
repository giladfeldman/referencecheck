# Contributing to referencecheck

Thank you for helping. referencecheck reports facts about real papers (retracted, withdrawn,
under an expression of concern, in a predatory journal) to the people who cite them. A wrong
answer that looks right, or a clean answer from a check that never ran, is the most serious
kind of bug here. The rules below exist to catch exactly that.

## Reporting a problem

Open an issue with the DOI (or reference text) that gives the wrong result, what
referencecheck returned, what the registry itself shows (a link to the Crossref record or
notice is ideal), and the version (the tag you installed).

## Development setup

```bash
git clone https://github.com/giladfeldman/referencecheck.git
cd referencecheck
npm install                           # also builds dist/ through the prepare script
npm test                              # offline Jest suite; every transport is mocked
npm run build                         # tsc + copy the bundled data into dist/
npm run docs:check                    # documentation-drift gate + offline quickstart
npm run docs:check -- --online        # ... and the quickstart blocks that call live APIs
npm run docs:check -- --no-run        # surface and version checks only
node scripts/live-check.mjs --verbose # the compiled library against the live APIs
```

## What a change needs

1. **A test that fails before the fix.** Write the test, watch it fail against the current
   code, then fix.
2. **Offline tests for failure modes.** Mock the transport: a live suite cannot express "and
   now the service rate-limits you". Use recorded responses (`tests/fixtures/`) rather than
   invented ones, because a synthetic fixture can only tell you the fixture is wrong.
3. **"Could not check" stays distinguishable from "clean".** If a new failure mode cannot be
   expressed by the return type, extend the type (see `checkRetractionDetailed` and
   `checkReferenceForEOCDetailed`) rather than returning an empty result.
4. **A live check for anything that reads an external API field.** Run
   `node scripts/live-check.mjs` against the compiled build.
5. **Documentation.** A new export, result field, literal value, parameter, issue code,
   environment variable or script flag must be documented in `README.md` or `docs/API.md`
   inside a code span. `npm run docs:check` fails otherwise and lists what is missing. Never
   add an exemption to make it pass.
6. **Release metadata.** A release bumps `package.json`, adds a `## x.y.z` entry at the top of
   `CHANGELOG.md`, and updates the version in the README install pin and in `CITATION.cff`;
   the docs gate checks that all four agree.

Never commit a personal contact address, API key or token; tests and scripts read contact
addresses from the environment.

## License

By contributing you agree that your contributions are licensed under the MIT License.

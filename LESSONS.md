# referencecheck lessons

## 2026-10-14 - doc-gate regexes must tolerate CRLF (qa v0.2.0)
`scripts/check-docs-coverage.mjs` `quickstartBlocks` matched fenced blocks on `\n` only. On a Windows
checkout (`core.autocrlf=true`, working tree CRLF, index LF) it found zero blocks and
`tests/docsCoverageGate.test.ts` failed with "README quickstart has no offline js block", which reads
as a README defect but is a line-ending defect. Fixed by normalising `\r\n` to `\n` before matching.
Any new script that regex-parses a tracked text file must normalise line endings first.

/**
 * Test helper: give a mocked source response the requested DOI where the mock
 * omits it, so tests about other behaviour need not repeat identity fields.
 * A mock that names a DOI keeps it (that is how mismatch tests are written).
 */
export function withIdentity(url: string, v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = JSON.parse(JSON.stringify(v));
  let doi = '';
  if (url.includes('api.crossref.org/works/')) doi = decodeURIComponent(url.split('/works/')[1].split('?')[0]);
  else if (url.includes('api.openalex.org/works/doi:')) doi = decodeURIComponent(url.split('doi:')[1].split('?')[0]);
  else if (url.includes('api.semanticscholar.org')) doi = decodeURIComponent(url.split('DOI:')[1].split('?')[0]);
  else if (url.includes('ebi.ac.uk')) doi = decodeURIComponent(url).split('DOI:"')[1]?.split('"')[0] ?? '';
  if (url.includes('crossref') && o.message && typeof o.message === 'object' && !Array.isArray(o.message) && !('DOI' in o.message)) o.message.DOI = doi;
  if (url.includes('openalex') && typeof o.id === 'string' && !('doi' in o)) o.doi = `https://doi.org/${doi}`;
  if (url.includes('semanticscholar') && typeof o.paperId === 'string' && !o.externalIds) o.externalIds = { DOI: doi };
  if (url.includes('ebi.ac.uk') && Array.isArray(o.resultList?.result)) {
    for (const r of o.resultList.result) if (r && typeof r === 'object' && !('doi' in r)) r.doi = doi;
  }
  return o;
}

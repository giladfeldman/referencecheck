/**
 * The given name a Crossref record of a cited author holds, read from how the reference writes
 * that author: the initials after the surname ("Smith J", "Smith, J. A."), the given names
 * before it ("Michael J. Young"), or the word after it in a family-first full name ("Wang
 * Xiaoming"). A family the reference does not name is another person: "Q.". Synthetic rows
 * up to round 16 gave every author "X.", which no real record has; round 17 compares the
 * record's given name where the name order is ambiguous, so the rows carry realistic ones.
 */
const plain = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
export function givenNameFor(text, family) {
  const at = plain(text).search(new RegExp(`(?<![a-z'’-])${plain(family).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z'’-])`));
  if (at < 0) return 'Q.';
  const before = text.slice(0, at);
  const after = text.slice(at + family.length);
  const initials = after.match(/^\s*,?\s*((?:\p{Lu}\.?\s?-?){1,3})(?=[\s,.;:(]|$)/u);
  if (initials) return [...initials[1].replace(/[^\p{Lu}]/gu, '')].map((l) => `${l}.`).join(' ');
  const givenFirst = before.match(/((?:\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?\s+|\p{Lu}\.\s*)+)$/u);
  if (givenFirst) return givenFirst[1].trim();
  const familyFirst = after.match(/^\s+(\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?)/u);
  return familyFirst ? familyFirst[1] : undefined;
}

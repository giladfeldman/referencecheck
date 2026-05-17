import type { ReferenceInput } from '../types.js';
import type { DuplicatePair, DuplicateGroup } from './types.js';
import { scoreMetadataCompleteness } from './similarity.js';

/**
 * Find duplicate groups using transitive closure
 * If A=B and B=C, then A=B=C is one group
 */
export function findDuplicateGroups(pairs: DuplicatePair[]): DuplicateGroup[] {
  if (pairs.length === 0) return [];

  // Build adjacency map
  const adjacency = new Map<string, Set<string>>();
  const refMap = new Map<string, ReferenceInput>();

  for (const pair of pairs) {
    refMap.set(pair.ref1.id, pair.ref1);
    refMap.set(pair.ref2.id, pair.ref2);

    if (!adjacency.has(pair.ref1.id)) {
      adjacency.set(pair.ref1.id, new Set());
    }
    if (!adjacency.has(pair.ref2.id)) {
      adjacency.set(pair.ref2.id, new Set());
    }

    adjacency.get(pair.ref1.id)!.add(pair.ref2.id);
    adjacency.get(pair.ref2.id)!.add(pair.ref1.id);
  }

  // Find connected components using BFS
  const visited = new Set<string>();
  const groups: DuplicateGroup[] = [];

  for (const [refId] of adjacency) {
    if (visited.has(refId)) continue;

    // BFS to find all connected references
    const group = new Set<string>();
    const queue = [refId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;

      visited.add(current);
      group.add(current);

      const neighbors = adjacency.get(current);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }
    }

    // Convert to Reference objects
    const groupRefs = Array.from(group)
      .map(id => refMap.get(id))
      .filter((ref): ref is ReferenceInput => ref !== undefined);

    if (groupRefs.length > 1) {
      // Calculate average similarity within group
      const groupPairs = pairs.filter(
        p => group.has(p.ref1.id) && group.has(p.ref2.id)
      );
      const avgSimilarity =
        groupPairs.length > 0
          ? groupPairs.reduce((sum, p) => sum + p.similarity, 0) / groupPairs.length
          : 0;

      // Select best reference (most complete metadata)
      const bestRef = selectBestReference(groupRefs);

      groups.push({
        references: groupRefs,
        bestReference: bestRef,
        averageSimilarity: avgSimilarity,
      });
    }
  }

  return groups;
}

/**
 * Select the best reference from a group (most complete metadata)
 */
export function selectBestReference(refs: ReferenceInput[]): ReferenceInput {
  if (refs.length === 0) {
    throw new Error('Cannot select best reference from empty array');
  }
  if (refs.length === 1) {
    return refs[0];
  }

  // Score each reference
  const scored = refs.map(ref => ({
    ref,
    score: scoreMetadataCompleteness(ref),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored[0].ref;
}

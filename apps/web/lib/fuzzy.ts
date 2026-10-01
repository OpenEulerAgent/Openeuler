/**
 * Tiny fuzzy matcher for the command palette (issue #50): subsequence match
 * with scoring — no external dependency.
 *
 * A query matches when its characters appear in the target in order
 * (case-insensitively). Scoring favors (in order of weight):
 *   - earlier first matches,
 *   - compact match spans,
 *   - runs of consecutive matches,
 *   - matches at word boundaries (target start or after a separator).
 */

export interface FuzzyMatch {
  /** Character indices in `target` that matched the query. */
  positions: number[];
  /** Higher is better; 0 is the floor. */
  score: number;
}

const SEPARATORS = new Set([" ", "/", "-", "_", ".", "(", "["]);

/** Normalized comparison key: lowercase, diacritics untouched (ASCII UI). */
function normalize(text: string): string {
  return text.toLowerCase();
}

/** Score one aligned match (positions parallel to the query characters). */
function scorePositions(target: string, positions: number[]): number {
  const first = positions[0] ?? 0;
  const last = positions[positions.length - 1] ?? 0;
  const span = last - first + 1;

  let score = 100;
  // Earlier matches win.
  score -= first * 2;
  // Compact spans win (span == query length is a straight substring).
  score -= (span - positions.length) * 4;
  // Consecutive runs win.
  let runs = 0;
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] === positions[i - 1]! + 1) runs += 1;
  }
  score += runs * 6;
  // Word-boundary starts win (target start or right after a separator).
  if (first === 0 || SEPARATORS.has(target[first - 1] ?? "")) score += 8;
  return Math.max(0, score);
}

/**
 * Return match info when every query character appears in `target` in order,
 * else null. Empty queries match everything with a neutral score.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = normalize(query);
  if (q.length === 0) return { positions: [], score: 0 };

  const t = normalize(target);
  const positions: number[] = [];
  let from = 0;
  for (const char of q) {
    const at = t.indexOf(char, from);
    if (at === -1) return null;
    positions.push(at);
    from = at + 1;
  }
  return { positions, score: scorePositions(t, positions) };
}

/**
 * Fuzzy-filter candidates and return matchers sorted best-first. Ties keep
 * the original order (stable). Empty queries return everything unscored.
 */
export function fuzzyFilter<T>(
  query: string,
  candidates: readonly T[],
  targetOf: (candidate: T) => string,
): Array<{ candidate: T; match: FuzzyMatch }> {
  const scored: Array<{ candidate: T; match: FuzzyMatch }> = [];
  candidates.forEach((candidate, index) => {
    const match = fuzzyMatch(query, targetOf(candidate));
    if (match) scored.push({ candidate, match: { ...match, score: match.score - index * 0.001 } });
  });
  scored.sort((a, b) => b.match.score - a.match.score);
  return scored;
}

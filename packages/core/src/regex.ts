/**
 * Returns true when `regex` (with optional `flags`) compiles into a valid
 * RegExp. Used at schema level so `outputMatches` conditions with invalid
 * patterns are rejected before a run ever starts.
 */
export function isValidRegex(regex: string, flags?: string): boolean {
  try {
    new RegExp(regex, flags);
    return true;
  } catch {
    return false;
  }
}

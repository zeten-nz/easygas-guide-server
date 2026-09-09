/**
 * Whitespace/case normalization for catalogue + reference text.
 *
 * `normalizeName` collapses runs of whitespace and trims — so "  Bosch   TDI "
 * and "Bosch TDI" are treated as the same value for DUPLICATE DETECTION. It does
 * NOT change case (display keeps the author's casing) and it never does fuzzy
 * matching: only exact post-normalization equality counts as a duplicate, and
 * different values are never auto-merged.
 */
export function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Case-insensitive comparison key for duplicate detection (uz locale). */
export function nameKey(value: string): string {
  return normalizeName(value).toLocaleLowerCase('uz-UZ');
}

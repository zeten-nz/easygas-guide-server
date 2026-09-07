/**
 * Pagination guards (Phase 10F hardening).
 *
 * Some routes read `page`/`pageSize` straight off `req.query` via `Number(...)`,
 * which yields `NaN` for a malformed value. `NaN ?? fallback` does NOT catch NaN
 * (nullish coalescing only covers null/undefined), so a NaN could previously flow
 * into `.limit()/.offset()` and make Knex throw "A valid integer must be provided
 * to offset". These helpers guarantee a safe positive integer offset can always
 * be computed — undefined/NaN/≤0/non-finite inputs fall back and clamp.
 */

/** A 1-based page number: finite integer ≥ 1, else `fallback` (default 1). */
export function safePage(value: unknown, fallback = 1): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** A page size clamped to [1, max]; undefined/NaN/≤0 → `fallback`. */
export function safePageSize(value: unknown, fallback = 20, max = 100): number {
  const n = typeof value === 'number' ? value : Number(value);
  const size = Number.isInteger(n) && n >= 1 ? n : fallback;
  return Math.min(max, size);
}

/** Row offset for a (page, pageSize) pair — always a finite integer ≥ 0. */
export function pageOffset(page: number, pageSize: number): number {
  return (safePage(page) - 1) * safePageSize(pageSize);
}

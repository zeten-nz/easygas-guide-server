/**
 * Normalizes an Uzbek plate number (davlat raqami) to canonical storage form:
 * uppercase, no spaces/dashes. "01 A 123 BC" → "01A123BC".
 * Returns null when the result is not plausible plate content.
 */
export function normalizePlate(input: string): string | null {
  const normalized = input.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{5,12}$/.test(normalized)) return null;
  return normalized;
}

/** Standard 17-char VIN (I, O, Q excluded). Input is uppercased first. */
export function normalizeVin(input: string): string | null {
  const normalized = input.toUpperCase().replace(/\s/g, '');
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(normalized)) return null;
  return normalized;
}

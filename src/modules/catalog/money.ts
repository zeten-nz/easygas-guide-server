import { ApiError } from '../../utils/errors';

/**
 * Fixed-point money — exact integer arithmetic only, never floating point.
 *
 * Prices are represented everywhere (DB, API, calculations) as `priceMinor`:
 * an integer count of the currency's MINOR unit. SCALE = 2, so 1 UZS = 100
 * minor units. `null` means the price is UNKNOWN; `0` is a real zero/free price
 * — the two are always distinguished.
 *
 * The API takes and returns integer minor units so no float ever touches an
 * authoritative price; presentation/formatting is the client's job.
 */
export const MONEY_SCALE = 2;
export const DEFAULT_CURRENCY = 'UZS';
export const SUPPORTED_CURRENCIES = ['UZS'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Upper bound for a single price: 1,000,000,000,000 minor = 10,000,000,000.00
 * UZS. Comfortably inside JS's safe-integer range (2^53) so integer math on
 * minor units is always exact.
 */
export const MAX_PRICE_MINOR = 1_000_000_000_000;

/** True for a storable price: an integer in [0, MAX] (null handled by callers). */
export function isValidPriceMinor(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_PRICE_MINOR;
}

/**
 * Validates an optional price. `undefined`/`null` pass through as "unknown".
 * A provided value must be an integer within bounds; a negative or fractional
 * value, or one over the cap, is a 400. Zero is explicitly allowed (free).
 */
export function assertPriceMinor(value: number | null | undefined): void {
  if (value === null || value === undefined) return;
  if (!isValidPriceMinor(value)) {
    throw ApiError.badRequest(
      `Narx 0 dan ${MAX_PRICE_MINOR} gacha butun (tiyin) qiymat bo'lishi kerak`,
      'INVALID_PRICE',
    );
  }
}

export function assertCurrency(currency: string | undefined): void {
  if (currency === undefined) return;
  if (!SUPPORTED_CURRENCIES.includes(currency as Currency)) {
    throw ApiError.badRequest(`Faqat ${SUPPORTED_CURRENCIES.join(', ')} valyutasi qo'llab-quvvatlanadi`, 'INVALID_CURRENCY');
  }
}

/** DB/driver may hand back BIGINT as string or number; normalize to number|null. */
export function readPriceMinor(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? Number(value) : value;
}

/** Plain "12 345 678" grouping of the MAJOR amount — used only for audit text. */
export function formatMinorForLog(value: number | null, currency = DEFAULT_CURRENCY): string {
  if (value === null) return 'noma’lum';
  const major = Math.trunc(value / 10 ** MONEY_SCALE);
  const grouped = major.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped} ${currency}`;
}

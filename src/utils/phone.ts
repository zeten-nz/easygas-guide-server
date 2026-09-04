/**
 * Normalizes an Uzbek phone number to canonical +998XXXXXXXXX form.
 * Accepts: "+998 90 123 45 67", "998901234567", "90 123-45-67" (9 digits).
 * Returns null if the input cannot be a valid Uzbek number.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  let national: string;
  if (digits.length === 12 && digits.startsWith('998')) {
    national = digits.slice(3);
  } else if (digits.length === 9) {
    national = digits;
  } else {
    return null;
  }
  return `+998${national}`;
}

export const PHONE_REGEX = /^\+998\d{9}$/;

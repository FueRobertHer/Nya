// lib/fx/rate-text.ts
//
// A rate of the person's own as they type it (lib/fx/settings.ts OwnRate):
// what it may be and, when it can't be one, why, in words. Pure, so the
// Currency card checks a rate as it is typed with the same rule the route
// saves it by.

/** An ISO code, or Plaid's unofficial one (a cryptocurrency's), as the API's
 *  currency argument takes it (lib/api-spec.ts). */
export const PRICED_CODE = /^[A-Z0-9]{2,10}$/;
/** A rate as typed: digits with a full stop, no more than 12 significant
 *  digits, between 1e-12 and 1e12. */
const RATE_TEXT = /^(\d{1,13})(?:\.(\d{1,24}))?$/;
const MIN_RATE = 1e-12;
const MAX_RATE = 1e12;

/** Why rate text can't be a rate, or null when it can. */
export function rateTextError(text: string): string | null {
  if (/^\s*\d+,\d+\s*$/.test(text)) return `Use a full stop for decimals: ${text.trim().replace(',', '.')}.`;
  const m = RATE_TEXT.exec(text);
  if (!m) return 'A rate is a number, like 0.92 or 61000.';
  const digits = (m[1] + (m[2] ?? '')).replace(/^0+/, '').replace(/0+$/, '');
  if (digits.length > 12) return 'A rate has at most 12 significant digits.';
  const value = Number(text);
  if (!(value >= MIN_RATE)) return 'A rate is more than zero.';
  if (value > MAX_RATE) return 'That rate is too large.';
  return null;
}

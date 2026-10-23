// lib/fx/decimal.ts
//
// Exact decimal arithmetic for converting money between currencies. Pure, and
// safe to import from client code.
//
// WHY NOT DOUBLES. A conversion is an amount times one rate divided by another,
// rounded once to the target currency's smallest unit. Done in doubles, a
// result exactly on half a unit can land just under it: €10.00 at 1.0005
// dollars per euro is exactly $10.005, which a double holds as
// 10.004999999999999, so it rounds to $10.00 where half away from zero gives
// $10.01. Here every amount and rate is read as the decimal it was written as
// and the arithmetic is on BigInt fractions, so the browser, the server and the
// tests round alike.
//
// WHAT IS READ. A rate as the text it was published or typed as ("1.1551"). An
// amount as the shortest text of its JS number (String(19.99) is "19.99", which
// is what the bank sent), exponent forms included: String(1e-8) is "1e-8".

/** A positive or negative exact fraction, its denominator always positive. */
export type Frac = { readonly n: bigint; readonly d: bigint };

/** A decimal as text: an optional minus, digits, an optional fraction, an
 *  optional exponent. No thousands separators, no decimal comma. */
const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
/** Far beyond any amount or rate, and small enough that 10 ** n stays cheap. */
const MAX_EXPONENT = 400;

/** The exact value of a decimal text or a finite number, or null when it is
 *  neither (NaN, Infinity, "1,5", "", "0x10"). */
export function parseDecimal(input: string | number): Frac | null {
  if (typeof input === 'number' && !Number.isFinite(input)) return null;
  const text = typeof input === 'number' ? String(input) : input;
  const m = DECIMAL.exec(text);
  if (!m) return null;
  const [, minus, whole, fraction = '', exp = '0'] = m;
  const e = Number(exp) - fraction.length;
  if (Math.abs(e) > MAX_EXPONENT) return null;
  let n = BigInt(whole + fraction);
  if (minus) n = -n;
  return e >= 0 ? { n: n * 10n ** BigInt(e), d: 1n } : { n, d: 10n ** BigInt(-e) };
}

/** a × b. */
export function mul(a: Frac, b: Frac): Frac {
  return { n: a.n * b.n, d: a.d * b.d };
}

/** a ÷ b, for a nonzero b. */
export function div(a: Frac, b: Frac): Frac {
  if (b.n === 0n) throw new RangeError('Division by zero');
  const n = a.n * b.d;
  const d = a.d * b.n;
  return d < 0n ? { n: -n, d: -d } : { n, d };
}

/** a + b. */
export function add(a: Frac, b: Frac): Frac {
  return { n: a.n * b.d + b.n * a.d, d: a.d * b.d };
}

/** Whether a is greater than zero. */
export const positive = (a: Frac): boolean => a.n > 0n;

/**
 * The fraction rounded to `digits` decimal places, half away from zero, as the
 * nearest JS number to that decimal (so 1731/100 is exactly the number 17.31
 * the rest of the app writes). Never -0.
 */
export function roundTo(f: Frac, digits: number): number {
  const scale = 10n ** BigInt(digits);
  const num = f.n * scale;
  const abs = num < 0n ? -num : num;
  let q = abs / f.d;
  if ((abs % f.d) * 2n >= f.d) q += 1n;
  if (q === 0n) return 0;
  const text = q.toString().padStart(digits + 1, '0');
  const whole = text.slice(0, text.length - digits);
  const decimals = text.slice(text.length - digits);
  return Number(`${num < 0n ? '-' : ''}${whole}${digits > 0 ? `.${decimals}` : ''}`);
}

/**
 * A float that is a sum of amounts (0.1 + 0.2 is 0.30000000000000004), as the
 * decimal those amounts add up to: rounded to `digits` places, half away from
 * zero, from its shortest text. What a subtotal is converted from, so the
 * browser and the server, which may add in different orders, convert the same
 * amount.
 */
export function tidyTo(sum: number, digits: number): Frac {
  const exact = parseDecimal(sum);
  if (!exact) throw new RangeError('Not a finite amount');
  const scale = 10n ** BigInt(digits);
  const num = exact.n * scale;
  const abs = num < 0n ? -num : num;
  let q = abs / exact.d;
  if ((abs % exact.d) * 2n >= exact.d) q += 1n;
  return { n: num < 0n ? -q : q, d: scale };
}

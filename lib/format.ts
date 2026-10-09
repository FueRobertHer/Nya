// lib/format.ts
//
// Shared money formatting. Amounts carry a currency (Plaid's iso_currency_code,
// its unofficial code for a cryptocurrency, or a manual row's own), so format
// in that currency rather than assuming USD: a EUR or GBP charge should not
// render with a "$". A code Intl doesn't take (Plaid's unofficial codes can be
// longer than three letters) is written after the number, "12.50 DOGE", never
// as dollars. Only with no currency at all does it fall back to a plain "$":
// the common single-currency case, and account-level figures (net worth,
// balances) that don't yet surface a currency code.

const plain = (abs: number) =>
  abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** The amount in a code Intl refused, the code after it: "-12.50 DOGE". */
function withCode(amount: number, currency: string, sign: string): string {
  return `${sign}${plain(Math.abs(amount))} ${currency}`;
}

export function formatMoney(amount: number, currency?: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
      }).format(amount);
    } catch {
      return withCode(amount, currency, amount < 0 ? '-' : '');
    }
  }
  return (amount < 0 ? '-$' : '$') + plain(Math.abs(amount));
}

/** With its sign shown: "+$12.00", "-¥3,200". `always` signs zero too
 *  ("+$0.00"); otherwise zero has none. */
export function signedMoney(amount: number, currency: string | null, opts: { always?: boolean } = {}): string {
  const n = amount === 0 ? 0 : amount; // never "-0"
  const sign = n > 0 || (n === 0 && opts.always) ? '+' : n < 0 ? '-' : '';
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        signDisplay: opts.always ? 'always' : 'exceptZero',
      }).format(n);
    } catch {
      return withCode(n, currency, sign);
    }
  }
  return `${sign}$${plain(Math.abs(n))}`;
}

// Compact form for dense labels (chart axes): $1.2K, €3.4M.
export function compactMoney(amount: number, currency?: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(amount);
    } catch {
      // A code Intl refuses: the compact number, the code after it.
      const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(amount));
      return `${amount < 0 ? '-' : ''}${compact} ${currency}`;
    }
  }
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${Math.round(abs)}`;
}

// The most common currency across a set of amounts, used to label summed
// figures (totals, budgets) with a single symbol. Null when nothing carries a
// currency. Nothing converts between currencies, so a total adds up only the
// amounts in this one and says what it left out (lib/spending.ts).
export function dominantCurrency(
  items: { iso_currency_code: string | null }[]
): string | null {
  const counts: Record<string, number> = {};
  for (const it of items) {
    const c = it.iso_currency_code;
    if (c) counts[c] = (counts[c] ?? 0) + 1;
  }
  let best: string | null = null;
  for (const [c, n] of Object.entries(counts)) {
    if (best === null || n > counts[best]) best = c;
  }
  return best;
}

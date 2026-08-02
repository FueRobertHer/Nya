// lib/format.ts
//
// Shared money formatting. Amounts carry a currency (Plaid's iso_currency_code),
// so format in that currency rather than assuming USD — a EUR/GBP charge should
// not render with a "$". Falls back to a plain "$" formatter when the currency
// is absent or unrecognized: the common single-currency case, and account-level
// figures (net worth, balances) that don't yet surface a currency code.

export function formatMoney(amount: number, currency?: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
      }).format(amount);
    } catch {
      // Unknown/invalid code — fall through to the $ formatter.
    }
  }
  return (
    (amount < 0 ? '-$' : '$') +
    Math.abs(amount).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
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
      // fall through
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
// currency. A true multi-currency total would need FX conversion — callers that
// sum across currencies should flag that rather than treat this as exact.
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

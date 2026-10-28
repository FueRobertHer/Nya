// lib/merchant-name.ts
//
// A bank's own text for a transaction, readable on screen. A row with no
// merchant name from Plaid shows the bank's descriptor, often all capitals
// and ending in a processor's marks ("CREDIT CARD 3333 PAYMENT *//"). Shown,
// it reads "Credit Card 3333 Payment". Only the shown name changes: search,
// rules, renames and exports keep the bank's text, and a name with any
// lowercase letter, or one the person or a rule gave, is shown as it is
// (lib/transactions.ts, `name_from_bank`). A security's name, which brokers
// send in capitals as often ("NH PORTFOLIO 1055 (FIDELITY INDEX)"), is shown
// through readableName too, so the funds' own letter words are kept below.

/** Short words kept lowercase inside a name. */
const SMALL = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'via', 'with']);

/** Words with vowels that are still read letter by letter: a bank's
 *  ("ACH", "ATM"), a fund's ("ETF", "REIT", "MSCI EAFE", "USD"), and the
 *  brokers and fund houses that write their names in capitals ("PIMCO"). */
const ACRONYMS = new Set([
  'AAA', 'ACH', 'AMC', 'ATM', 'EFT', 'ESPN', 'HBO', 'IOU', 'IRS', 'POS', 'UPS', 'USA', 'USAA', 'USPS',
  'ADR', 'EAFE', 'ESG', 'ETF', 'ETN', 'EUR', 'FTSE', 'HSA', 'IRA', 'MSCI', 'REIT', 'USD',
  'AQR', 'CREF', 'NVIDIA', 'PGIM', 'PIMCO', 'SPDR', 'TIAA', 'TRP',
]);

/** Words a brand writes its own way. */
const CASED: ReadonlyMap<string, string> = new Map([
  ['BLACKROCK', 'BlackRock'],
  ['DOUBLELINE', 'DoubleLine'],
  ['ISHARES', 'iShares'],
  ['JPMORGAN', 'JPMorgan'],
  ['PROSHARES', 'ProShares'],
  ['TROWE', 'T. Rowe'],
  ['VANECK', 'VanEck'],
  ['WISDOMTREE', 'WisdomTree'],
]);

/** One run of letters: capitalised, or kept in capitals when it reads as
 *  letters (no vowel, like "CVS" or "SQ", or a known acronym), or is two
 *  letters (a state, "US", "PO"), unless a short word inside the name ("of"),
 *  which a state at the end ("PORTLAND OR") is not. */
function word(w: string, first: boolean, last: boolean): string {
  const lower = w.toLowerCase();
  const cased = CASED.get(w);
  if (cased) return cased;
  if (!first && !last && SMALL.has(lower)) return lower;
  if (w.length === 2 || (/^[^aeiou]+$/i.test(w) && w.length <= 4) || ACRONYMS.has(w)) return w;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** One space-separated token: one with a digit or "&" is a code or a brand
 *  ("3333", "7-ELEVEN", "AT&T") and stays as written; otherwise each run of
 *  letters is a word, so "*BLUE" becomes "*Blue" and "WAL-MART" "Wal-Mart",
 *  an apostrophe keeps "JOE'S" one word, and an accented capital ("CAFÉ")
 *  stays inside its word. */
function token(t: string, first: boolean, last: boolean): string {
  if (/[0-9&]/.test(t)) return t;
  const runs = t.match(/\p{L}+(?:'\p{L}+)*/gu) ?? [];
  let at = 0;
  return t.replace(/\p{L}+(?:'\p{L}+)*/gu, (run) => {
    const out = word(run, first && at === 0, last && at === runs.length - 1);
    at += 1;
    return out;
  });
}

/** The name as shown: unchanged unless it is all capitals. */
export function readableName(name: string): string {
  if (!/\p{Lu}/u.test(name) || /\p{Ll}/u.test(name)) return name;
  const tokens = name.trim().split(/\s+/);
  // A processor's trailing marks ("*//", "#", "-") say nothing.
  while (tokens.length > 1 && !/[\p{L}0-9]/u.test(tokens[tokens.length - 1])) tokens.pop();
  return tokens.map((t, i) => token(t, i === 0, i === tokens.length - 1)).join(' ');
}

/** What a transaction's name shows as: the bank's text made readable when
 *  it is the bank's (no merchant name, no rename, no rule's name), else the
 *  name as given. */
export function shownName(t: { name: string; name_from_bank?: true }): string {
  return t.name_from_bank ? readableName(t.name) : t.name;
}

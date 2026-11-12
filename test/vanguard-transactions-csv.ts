// Synthetic transactions downloads in Vanguard's CSV layout, for the reader's
// tests (test/vanguard-transactions.test.ts). Every figure and account number
// is made up: no real person's file is kept anywhere in this repository.
//
// Laid out as Vanguard writes the file (learnt from a real one's layout,
// never its figures): the holdings table, each account's positions with a
// blank line after them, then the transactions table, then two blank lines.
// Every line ends in a comma, dates are YYYY-MM-DD, amounts plain decimals,
// and Net Amount is the cash effect, positive into the account. A conversion
// or a transfer of shares comes as an in-kind row (the shares, a price of 0,
// their value in Net Amount), often beside a cash row of the same type.
//
// Run directly to write the sample to a file to look at:
//   bun test/vanguard-transactions-csv.ts <file>

import { HOLDINGS_HEADER, TRANSACTIONS_HEADER } from '@/lib/import/vanguard-transactions';

export type Holding = { account: string; name: string; symbol: string; shares: number; price: number };

export type Txn = {
  account: string;
  trade: string;
  settle?: string;
  type: string;
  description?: string;
  /** Investment Name; a cash row's is the account's cash. */
  name?: string;
  symbol?: string;
  shares?: number;
  price?: number;
  net: number;
  /** Principal Amount; the net amount unless said. */
  principal?: number;
  fees?: number;
  accrued?: number;
  accountType?: string;
};

export type CsvOptions = {
  eol?: '\n' | '\r\n';
  bom?: boolean;
  /** Blank lines after the table. */
  trailing?: number;
  /** Leave the holdings table out. */
  noHoldings?: boolean;
  /** Replace the transactions heading. */
  header?: string[];
};

/** A field as Vanguard writes it, quoted only when it must be. */
function field(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (cells: string[]) => `${cells.map(field).join(',')},`;

/** A Vanguard amount: plain, a minus when negative, no thousands commas. */
export function amount(n: number, places = 2): string {
  return n.toFixed(places);
}

export function vanguardCsv(holdings: Holding[], txns: Txn[], o: CsvOptions = {}): string {
  const out: string[] = [];
  if (!o.noHoldings) {
    out.push(line([...HOLDINGS_HEADER]));
    const accounts = [...new Set(holdings.map((h) => h.account))];
    for (const account of accounts) {
      for (const h of holdings.filter((x) => x.account === account)) {
        out.push(line([h.account, h.name, h.symbol, amount(h.shares, 4), amount(h.price), amount(h.shares * h.price)]));
      }
      out.push('');
    }
  }
  out.push(line(o.header ?? [...TRANSACTIONS_HEADER]));
  for (const t of txns) {
    out.push(
      line([
        t.account,
        t.trade,
        t.settle ?? t.trade,
        t.type,
        t.description ?? t.type,
        t.name ?? (t.symbol ? `${t.symbol} Fund` : 'CASH'),
        t.symbol ?? '',
        amount(t.shares ?? 0, 4),
        amount(t.price ?? 0),
        amount(t.principal ?? t.net),
        amount(t.fees ?? 0),
        amount(t.net),
        amount(t.accrued ?? 0),
        t.accountType ?? 'CASH',
      ])
    );
  }
  for (let i = 0; i < (o.trailing ?? 2); i++) out.push('');
  const eol = o.eol ?? '\n';
  return (o.bom ? '﻿' : '') + out.join(eol) + eol;
}

/** Made-up accounts: three in Nya and one in the same Vanguard login that
 *  isn't, plus one with holdings and no transactions. */
export const ACCOUNTS = {
  individual: '11114421',
  roth: '22223307',
  traditional: '33335519',
  elsewhere: '44448802',
  quiet: '55556610',
} as const;

const A = ACCOUNTS;

export const SAMPLE_HOLDINGS: Holding[] = [
  { account: A.individual, name: 'Total Stock Market Index Fund', symbol: 'TSMF', shares: 512.3, price: 140.5 },
  { account: A.individual, name: 'Federal Money Market Fund', symbol: 'FMMF', shares: 2210.15, price: 1 },
  { account: A.roth, name: 'Total Stock Market Index Fund', symbol: 'TSMF', shares: 180.2, price: 140.5 },
  { account: A.traditional, name: 'Total Bond Market Index Fund', symbol: 'TBMF', shares: 900.4, price: 9.75 },
  { account: A.elsewhere, name: 'Federal Money Market Fund', symbol: 'FMMF', shares: 50, price: 1 },
  { account: A.quiet, name: 'Federal Money Market Fund', symbol: 'FMMF', shares: 12, price: 1 },
];

/** Every type Nya reads in files it has been checked on, in each account,
 *  newest first as Vanguard lists them. */
export const SAMPLE_TXNS: Txn[] = [
  // The individual account: a deposit each month, swept and invested.
  { account: A.individual, trade: '2026-11-02', type: 'Funds Received', description: 'Funds Received via electronic transfer', net: 2000 },
  { account: A.individual, trade: '2026-11-02', type: 'Sweep in', description: 'Sweep in from settlement fund', name: 'Federal Money Market Fund', symbol: 'FMMF', price: 1, net: -2000 },
  { account: A.individual, trade: '2026-10-30', settle: '2026-11-02', type: 'Buy', name: 'Total Stock Market Index Fund', symbol: 'TSMF', shares: 14.2349, price: 140.5, net: -2000 },
  { account: A.individual, trade: '2026-10-30', type: 'Sweep out', description: 'Sweep out to settlement fund', name: 'Federal Money Market Fund', symbol: 'FMMF', price: 1, net: 2000 },
  { account: A.individual, trade: '2026-09-28', type: 'Dividend', description: 'Dividend received', name: 'Total Stock Market Index Fund', symbol: 'TSMF', net: 212.4 },
  { account: A.individual, trade: '2026-09-28', type: 'Reinvestment', description: 'Reinvestment of dividend', name: 'Total Stock Market Index Fund', symbol: 'TSMF', net: -212.4 },
  { account: A.individual, trade: '2026-06-30', type: 'Interest', description: 'Interest received', net: 3.12 },
  // The Roth: a contribution, a rollover, and a conversion arriving from the
  // traditional IRA, in cash and in kind.
  { account: A.roth, trade: '2026-03-04', type: 'Conversion (incoming)', description: 'Roth conversion', name: 'Total Stock Market Index Fund', symbol: 'TSMF', shares: 98.1203, price: 0, net: 15400 },
  { account: A.roth, trade: '2026-03-04', type: 'Conversion (incoming)', description: 'Roth conversion', net: 600 },
  { account: A.roth, trade: '2026-01-05', type: 'Contribution', description: 'Contribution for 2026', net: 7000 },
  { account: A.roth, trade: '2025-07-15', type: 'Rollover (incoming)', description: 'Direct rollover from employer plan', net: 25000 },
  // The traditional IRA: the conversion leaving.
  { account: A.traditional, trade: '2026-03-04', type: 'Conversion (outgoing)', description: 'Roth conversion', name: 'Total Stock Market Index Fund', symbol: 'TSMF', shares: -98.1203, price: 0, net: -15400 },
  { account: A.traditional, trade: '2026-03-04', type: 'Conversion (outgoing)', description: 'Roth conversion', net: -600 },
  { account: A.traditional, trade: '2025-06-02', type: 'Dividend', description: 'Dividend received', name: 'Total Bond Market Index Fund', symbol: 'TBMF', net: 41.07 },
  // The account that isn't in Nya.
  { account: A.elsewhere, trade: '2025-05-14', type: 'Funds Received', description: 'Funds Received via electronic transfer', net: 50 },
];

export function sampleCsv(o: CsvOptions = {}): string {
  return vanguardCsv(SAMPLE_HOLDINGS, SAMPLE_TXNS, o);
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: bun test/vanguard-transactions-csv.ts <file>');
    process.exit(1);
  }
  await Bun.write(file, sampleCsv());
  console.log(`wrote ${file}`);
}

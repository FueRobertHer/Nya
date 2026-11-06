// components/plan-buckets.ts
//
// The words of the Invested assets sheet's tax buckets and Annual savings' split
// (components/PlanBuckets.tsx). In the flat model these are facts about the
// money, never a warning: a gap is said quietly (the tax plan's Honesty), and its
// cautions come with the detailed model. No React here.

import { BUCKET_NAMES, type BucketSlot, type TaxBucket } from '@/lib/allocation/buckets';
import type { BucketAccount, BucketsToday } from '@/lib/fire/buckets-today';
import type { SavingsSplit } from '@/lib/fire/savings-split';
import type { Owner } from '@/lib/fire/tax-facts';

type Money = (n: number) => string;

/** Whose an account is, once there are two people to tell apart. */
export const ownerWord = (owner: Owner) => (owner === 'you' ? 'Yours' : 'Your partner’s');

/** A row's name: the account's, with its institution when two would read alike. */
export function rowTitle(account: { name: string; institution: string }, names: ReadonlyMap<string, number>): string {
  return (names.get(account.name) ?? 0) > 1 ? `${account.institution} ${account.name}` : account.name;
}

/** How many of each name the sheet lists. */
export function namesOf(today: Pick<BucketsToday, 'groups' | 'leftOut'>): Map<string, number> {
  const names = new Map<string, number>();
  for (const a of [...today.groups.flatMap((g) => g.accounts), ...today.leftOut.accounts]) names.set(a.name, (names.get(a.name) ?? 0) + 1);
  return names;
}

function gainWords(gain: number, money: Money): string {
  return gain < 0 ? `loss ${money(-gain)}` : `gain ${money(gain)}`;
}

/** What a taxable account's row says about what it cost. */
export function basisWords(a: Pick<BucketAccount, 'basis' | 'basisFrom' | 'gain'>, money: Money): string {
  if (a.basisFrom === 'cash') return '';
  if (a.basis === null || a.gain === null) return 'Cost basis not known';
  const gain = gainWords(a.gain, money);
  return a.basisFrom === 'partial' ? `Cost basis ${money(a.basis)} so far · ${gain}` : `Cost basis ${money(a.basis)} · ${gain}`;
}

/** The line under a row's name. */
export function accountSub(a: BucketAccount, money: Money, partner: boolean): string {
  const whose = partner || a.owner === 'partner' ? ownerWord(a.owner) : '';
  const cost = a.bucket === 'taxable' ? basisWords(a, money) : '';
  return [whose, cost].filter(Boolean).join(' · ');
}

/** The sheet's head line. */
export function headLine(total: number, accounts: number, asOf: string | null, money: Money): string {
  return `${money(total)} in ${accounts} account${accounts === 1 ? '' : 's'}${asOf ? `, as of ${asOf}` : ''}.`;
}

/** What the left-out group says, on the sheet and in its row. */
export function leftOutLine(leftOut: BucketsToday['leftOut'], money: Money): string {
  const n = leftOut.accounts.length;
  const amount = leftOut.total > 0 ? `, ${money(leftOut.total)}` : '';
  return `Leaves out ${n} account${n === 1 ? '' : 's'} for a child’s education${amount}: ${n === 1 ? 'it isn’t' : 'they aren’t'} there for your years after work.`;
}

/** What the unclassified group's helper says (D8). */
export const UNCLASSIFIED_NOTE = 'Nya can’t tell how these are taxed from their type, and counts them as tax-deferred until you say.';

const bucketWord = (b: BucketSlot) => (b === 'taxable' || b === 'tax-deferred' || b === 'education' ? BUCKET_NAMES[b].toLowerCase() : BUCKET_NAMES[b]);

/** The projected mix, in a line. */
export function mixLine(age: number, shares: readonly { bucket: TaxBucket; pct: number }[]): string | null {
  if (shares.length === 0) return null;
  return `At ${Math.round(age)}, about ${shares.map((s) => `${s.pct}% ${bucketWord(s.bucket)}`).join(', ')}.`;
}

/** A year's opening balances as the mix's shares, largest first. */
export function balanceShares(b: { taxable: number; deferred: number; roth: number; hsa: number }): { bucket: TaxBucket; pct: number }[] {
  const total = b.taxable + b.deferred + b.roth + b.hsa;
  if (total <= 0) return [];
  const parts: [TaxBucket, number][] = [
    ['taxable', b.taxable],
    ['tax-deferred', b.deferred],
    ['roth', b.roth],
    ['hsa', b.hsa],
  ];
  return parts
    .map(([bucket, value]) => ({ bucket, pct: Math.round((value / total) * 100) }))
    .filter((s) => s.pct > 0)
    .sort((x, y) => y.pct - x.pct);
}

/** Why the buckets matter, behind the disclosure. */
export function bucketsWhy(partner: boolean, detailed = false): string {
  return `Each is taxed differently when you draw it: only the gain when you sell from taxable, all of it from tax-deferred, none from Roth. Before 59½, Nya counts only some of it as reachable without a penalty${partner ? ', and each of you has your own 59½' : ''}.${detailed ? '' : ' With a flat tax rate these don’t change your plan’s figures.'}`;
}

/** The HSA, as a detailed plan draws it. */
export const HSA_WORDS = 'From 65 it pays Medicare Part B and its income surcharge (IRMAA) untaxed, then is taxed like tax-deferred money. Before 65, money not spent on medical costs pays tax and a 20% penalty, so it’s drawn last.';

/** When required withdrawals start, under the tax-deferred group. */
export function rmdLine(ages: { you: number; partner: number }, partner: boolean): string {
  if (partner && ages.you !== ages.partner) return `Required withdrawals start at ${ages.you} for you and ${ages.partner} for your partner.`;
  return `Required withdrawals start at ${ages.you}${partner ? ' for each of you' : ''}.`;
}

/** Said under Annual savings' split. */
export function splitNote(from: SavingsSplit['from']): string {
  if (from === 'contributions') return 'From the last year’s contributions to each account. The rest of your savings counts as taxable.';
  if (from === 'balances') return 'Nothing measured in the last year, so this follows today’s balances.';
  return 'No accounts to go by, so this counts as taxable.';
}

export const STILL_READING = 'Still reading contributions.';

/** Over an amount held with no Roth account counted: lib/fire/tax/mix.ts reads it
 *  only against a Roth account's money. Said as the rule, since balances still
 *  loading draw this too, and that isn't a reason to clear an amount. */
export const ROTH_HELD_NOTE = 'Your plan only uses what’s here once a Roth account is counted.';

/** Said under the cost basis field: where the figure comes from. */
export function basisNote(a: Pick<BucketAccount, 'basisFrom'>): string {
  if (a.basisFrom === 'typed') return 'Your own figure. Leave it empty to use what its positions say.';
  if (a.basisFrom === 'partial') return 'From its positions. Some have no cost basis, so they count as all gain. Type your own if you know it.';
  if (a.basisFrom === 'positions') return 'From its positions. Type your own if you know better.';
  return 'Its positions don’t say. Type it if you know it.';
}

/** The last year's dividends and interest, in a line. */
export function yieldWords(income: number | null, yieldRate: number | null, money: Money): string {
  if (income === null) return 'Not known yet';
  return yieldRate === null ? `${money(income)} a year` : `${money(income)} a year, ${(yieldRate * 100).toFixed(1)}%`;
}

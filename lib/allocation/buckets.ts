// lib/allocation/buckets.ts
//
// Tax buckets: what kind of tax shelter an investment account is, from
// Plaid's account subtype, with the person's own choice winning over it.
//
// The subtype says what the account is (a 401(k), a Roth IRA, a brokerage
// account), and for most of them that settles how the money in it is taxed.
// Not for all: a 401(k) can hold Roth money and its subtype won't say so, a
// "retirement" account could be either kind, and a GIC can sit inside any
// account. Where the subtype alone can't settle it the account is
// unclassified, never a guess, and the person can set any account's bucket
// themselves (lib/allocation/settings.ts).
//
// Every investment subtype Plaid lists (InvestmentAccountSubtype in the plaid
// package) is decided here on purpose, with a test each
// (test/allocation.test.ts), which also fails when a Plaid release lists one
// this table hasn't decided. Plaid's own descriptions of them are in its
// account schema docs; Canadian and UK accounts are placed by how they are
// taxed: a TFSA or an ISA is after-tax money that grows and comes out tax
// free, as a Roth does, and an RRSP or a SIPP is taxed when it comes out.
//
// Imports nothing, like lib/cash.ts: the Plan tab runs this in the browser.

export const TAX_BUCKETS = ['taxable', 'tax-deferred', 'roth', 'hsa', 'education'] as const;
export type TaxBucket = (typeof TAX_BUCKETS)[number];
/** A bucket, or unclassified when neither the subtype nor the person says. */
export type BucketSlot = TaxBucket | 'unclassified';

export const BUCKET_SLOTS: readonly BucketSlot[] = [...TAX_BUCKETS, 'unclassified'];

export const BUCKET_NAMES: Record<BucketSlot, string> = {
  taxable: 'Taxable',
  'tax-deferred': 'Tax-deferred',
  roth: 'Roth',
  hsa: 'HSA',
  education: 'Education',
  unclassified: 'Unclassified',
};

/** What each bucket means, for the form that sets one. */
export const BUCKET_TEXT: Record<TaxBucket, string> = {
  taxable: 'No tax shelter: a brokerage account, say. Gains and dividends are taxed as they come.',
  'tax-deferred': 'Taxed when it comes out: a traditional 401(k) or IRA, an RRSP.',
  roth: 'Paid in after tax and taken out tax free: a Roth IRA or Roth 401(k), a TFSA, an ISA.',
  hsa: 'A health savings account.',
  education: 'Saved for education: a 529 plan, a Coverdell, an RESP.',
};

/**
 * Every investment subtype Plaid lists, with its bucket, or the reason the
 * subtype alone can't give one. Keys are lower case: Plaid writes "403B".
 * A few subtypes Plaid lists under other types, or under none, but which
 * reach investment accounts in practice, are here too (the TSP, which
 * lib/fire/inputs.ts counts as a workplace plan; cash management and money
 * market accounts carried under an investment Item, as lib/cash.ts notes).
 */
const BY_SUBTYPE: Record<string, TaxBucket | { why: string }> = {
  // US workplace plans and IRAs, taxed when the money comes out. A 401(k) can
  // also hold Roth money, which its subtype doesn't say: the person can set it.
  '401a': 'tax-deferred',
  '401k': 'tax-deferred',
  '403b': 'tax-deferred',
  '457b': 'tax-deferred',
  ira: 'tax-deferred',
  keogh: 'tax-deferred',
  'profit sharing plan': 'tax-deferred',
  sarsep: 'tax-deferred',
  'sep ira': 'tax-deferred',
  'simple ira': 'tax-deferred',
  'thrift savings plan': 'tax-deferred',
  tsp: 'tax-deferred',
  pension: 'tax-deferred',
  // An annuity's growth is taxed only when it is paid out (Plaid describes a
  // variable annuity as "tax-deferred capital accumulation").
  'fixed annuity': 'tax-deferred',
  'variable annuity': 'tax-deferred',
  'other annuity': 'tax-deferred',
  // Canada: registered retirement plans and their locked-in and income forms,
  // and the disability savings plan, whose growth is taxed when paid out.
  rrsp: 'tax-deferred',
  rrif: 'tax-deferred',
  lira: 'tax-deferred',
  lrsp: 'tax-deferred',
  lif: 'tax-deferred',
  lrif: 'tax-deferred',
  prif: 'tax-deferred',
  rlif: 'tax-deferred',
  rdsp: 'tax-deferred',
  // UK: a self-invested personal pension.
  sipp: 'tax-deferred',

  // After-tax money that grows and comes out tax free.
  roth: 'roth',
  'roth 401k': 'roth',
  tfsa: 'roth',
  isa: 'roth',
  'cash isa': 'roth',

  hsa: 'hsa',

  '529': 'education',
  'education savings account': 'education',
  resp: 'education',

  // No shelter.
  brokerage: 'taxable',
  'crypto exchange': 'taxable',
  'non-custodial wallet': 'taxable',
  'stock plan': 'taxable',
  trust: 'taxable',
  ugma: 'taxable',
  utma: 'taxable',
  'cash management': 'taxable',
  'money market': 'taxable',

  // Known, but the subtype alone doesn't say how the money is taxed.
  retirement: { why: "Plaid calls it a retirement account without saying which kind, so it may be tax-deferred or Roth" },
  'non-taxable brokerage account': { why: "Plaid says it isn't taxable, but not whether it is tax-deferred or Roth" },
  'mutual fund': { why: "Plaid's type for it says what it holds, not how it is taxed" },
  gic: { why: 'a GIC can be held in any kind of account' },
  'health reimbursement arrangement': { why: "it is an employer's health reimbursement arrangement, not an HSA" },
  'life insurance': { why: 'an insurance policy has tax rules of its own' },
  'other insurance': { why: 'an insurance policy has tax rules of its own' },
  // Plaid's catch-all, and one this table doesn't know.
  other: { why: "Plaid doesn't say what kind of account it is" },
  qshr: { why: "Nya doesn't know this kind of account" },
};

/** The subtypes this table decides, for the test that checks it against
 *  Plaid's own list. */
export const DECIDED_SUBTYPES: readonly string[] = Object.keys(BY_SUBTYPE);

/** What the subtype says: a bucket, or why it can't give one. */
export function subtypeBucket(subtype: string | null | undefined): { bucket: TaxBucket } | { bucket: null; why: string } {
  if (!subtype) return { bucket: null, why: "its institution didn't say what kind of account it is" };
  const found = Object.hasOwn(BY_SUBTYPE, subtype.toLowerCase()) ? BY_SUBTYPE[subtype.toLowerCase()] : undefined;
  if (found === undefined) return { bucket: null, why: "Nya doesn't know this kind of account" };
  return typeof found === 'string' ? { bucket: found } : { bucket: null, why: found.why };
}

/** Where an account's bucket came from. */
export type BucketFrom = 'you' | 'subtype' | 'none';

export type AccountBucket = {
  bucket: BucketSlot;
  from: BucketFrom;
  /** What the subtype alone says, so a form can offer to go back to it. */
  subtype: BucketSlot;
  /** Why the subtype gives none, when it doesn't. */
  why: string | null;
};

/** An account's bucket: the person's choice, else what its subtype says,
 *  else unclassified. */
export function accountBucket(subtype: string | null | undefined, chosen: TaxBucket | undefined): AccountBucket {
  const s = subtypeBucket(subtype);
  const fromSubtype: BucketSlot = s.bucket ?? 'unclassified';
  const why = s.bucket === null ? s.why : null;
  if (chosen) return { bucket: chosen, from: 'you', subtype: fromSubtype, why };
  return { bucket: fromSubtype, from: s.bucket ? 'subtype' : 'none', subtype: fromSubtype, why };
}

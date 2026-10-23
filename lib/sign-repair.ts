// lib/sign-repair.ts
//
// Turning one account's past balances over when the kind it is read as
// crossed between money held and money owed (designs: owed-flip, sign-repair).
//
// WHAT IS STORED. Each day's total is signed when it is written; beside it,
// every account's balance is kept unsigned, in Nya's convention (a card's or
// a loan's is the amount owed: lib/history.ts), and every reader that takes
// an account back out of a total, or splits one, signs it with one type: its
// hidden or lifecycle entry's, or the account's own now. So an account read
// as the other kind from some day on reads every day before it the other way.
// Two things still do that:
//
//   RETYPE   SimpleFIN's and Lunch Flow's "what kind of account is this"
//            (lib/connectors/manage.ts retypeAccounts): a tracked account's
//            recorded value follows its kind (nyaBalance), so a card reported
//            at -300 was recorded as -300 while it was typed checking and as
//            300 once it is a card, its total the same either way.
//   REPAIR   a manual account flipped under a release before the app refused
//            it (lib/manual-account-writes.ts OWED_FLIP), or a tracked one
//            retyped under a release before this: read the other way from
//            the change on.
//
// PROVEN BY THE TOTALS. On a day with a total, sign every value in its
// breakdown by its account's type now: the sum falls short of the total by
// a gap (0 when every account was counted as it reads now). Every set of the
// day's candidates (the manual and tracked accounts, the only ones a person
// could change) whose values, counted the other way, close that gap exactly
// is an explanation of the day. With exactly one, each candidate in it was
// counted the other way that day ('flip') and every other one as now ('ok').
// With more than one (two accounts flipped together whose values add up to
// a third's, or a held 300 beside an owed 300), the candidates in any of them
// can't be told ('ambiguous'), and the rest are 'ok'. With none, or a value
// of an account whose type isn't known, or anything unreadable, nothing is
// proven ('unknown'). Estimated days the same, against the estimated total,
// the walked map and that day's flat record. A value of 0 needs nothing.
//
// INFERRED FROM NEIGHBOURS. A day without a total (a partial day, a value
// walked past the estimate), or one nothing proves, takes the label of the
// nearest proven days on both sides when they agree: that assumes the account
// didn't change and change back between two proven days. When they disagree
// the day it changed lies there and can't be found ('boundary'); with a
// proven day on one side only, it is 'undetermined' beside an 'ok' (left as
// it is, and reported, never taken for 'ok') and can't be told beside a
// 'flip' (the run of other-way days reaches an end nothing marks).
//
// ONE MECHANISM. A job (the `sign-repairs` store, by account id) plans each
// layer and day to turn over, with the account's value there, and turns each
// over in one compare-and-set only while the account's value there is still
// that one (lib/history.ts negateAccountOn): a fold of another account or a
// re-encryption, rewriting the map, leaves it to be turned over still; one
// turned over already, or written since in the new sign, is left. So nothing
// is ever turned over twice, and a job cut off part way is finished by running
// it again: by the request that started it, by the nightly snapshot
// (finishSignJobs, which stops trying one past MAX_FAILED_NIGHTS and leaves
// it to the operator's dry run), or by the operator. Before running a saved
// plan the account's kind is checked again: no longer on the side it was
// planned for (changed back under the release before, say), the job is
// dropped with words and nothing more is turned over. Every total stays as
// recorded; the account's hidden and lifecycle entries take its type now.
// Under the links lock, as a fold is, within JOB_BUDGET_MS of the lock (a
// job past it stops between days and is finished by the next run); a forget
// or an undo of an account with a job pending is refused (lib/links.ts,
// lib/api-undo.ts).
//
//   RETYPE   the job is written before the kind changes, and the change is
//            its first step. Planned under the new kind: 'flip' days, proven
//            or inferred, are turned over and 'ok' ones kept (an older retype
//            is put right so). On the retype's own day a value nothing proves
//            is turned over when it is the account's balance under the old
//            kind and not under the new (recorded just before). Every other
//            day is left as it is and reported.
//   REPAIR   'flip' days, proven or inferred, are turned over; an
//            'ambiguous' day, a 'boundary' or a run reaching an end nothing
//            marks refuses the repair, naming the days, writing nothing;
//            'undetermined' days are left and reported. Run by the operator
//            (app/api/ops/sign-repair), after a dry run.
//
// NOT HERE: an account's earlier ids (links). Each is subtracted by the kind
// its link recorded, and the split by currency reads them by the account's
// type now, as before.
//
// THE RELEASE BEFORE reads every value with the type its account has now,
// as this one does: no reader changes, and no stored shape. It ignores this
// store, so a job still pending under a rollback leaves its account read as
// it always was there until this release finishes it.

import { randomUUID } from 'node:crypto';
import type { Ctx } from './containers';
import { isOwedType } from './balance';
import { dropFoldProgress, negateAccountOn, readSignLayers, readSignValue, splitLegacyFlat, type SignLayer, type SignLayers } from './history';
import { getHiddenAccounts, setHiddenType } from './hidden';
import { lifecycleStore } from './lifecycle';
import { directoryTypes, ForgetRefused, withLinksLock } from './links';
import { getManualAccount, getManualAccounts } from './manual';
import { connectorAccountsStore, type ConnectorAccount } from './connectors/store';
import { nyaBalance } from './connectors/institutions';
import { clearCaches } from './cache';
import { MAX_FAILED_NIGHTS, SIGN_LAYERS, signJobStore, type SignJob, type SignPlan } from './sign-repair-store';

export { signJobStore, type SignJob, type SignPlan };

const LAYERS = SIGN_LAYERS;

/** How long a job may run under the links lock in one go, under the lock's
 *  own LINKS_LOCK_REQUEST_SECONDS: past it a job stops between days. */
export const JOB_BUDGET_MS = 90_000;

/** At most this many candidates on one day are weighed; past it the day is
 *  'unknown' for every one of them (never guessed). */
const MAX_CANDIDATES = 24;
/** Past this many explanations of one day, every candidate is 'ambiguous'. */
const MAX_EXPLANATIONS = 256;

/** A repair that can't be told exactly, with the days that say why. */
export class SignRepairRefused extends Error {
  constructor(
    message: string,
    readonly days: string[]
  ) {
    super(message);
    this.name = 'SignRepairRefused';
  }
}

// ---- Reading what the totals say ----

type Label = 'ok' | 'flip' | 'unknown' | 'ambiguous';
/** A label once neighbours are read: 'boundary' (between a 'flip' and an
 *  'ok'), 'edge' (a 'flip' on one side only), 'undetermined' (an 'ok' on
 *  one side only, or nothing proven at all). */
type Status = 'ok' | 'flip' | 'ambiguous' | 'boundary' | 'edge' | 'undetermined';
type Entry = { layer: SignLayer; date: string; value: number; label: Label; status?: Status };

const cents = (n: number) => Math.round(n * 100);
const signed = (type: string, v: number) => (isOwedType(type) ? -v : v);

/** Decrypted maps and totals, each read once a run. */
class Reading {
  readonly maps = new Map<string, Record<string, number> | null>();
  readonly totals = new Map<string, number | null>();
  constructor(readonly ctx: Ctx) {}

  async map(blob: string | undefined): Promise<Record<string, number> | null> {
    if (!blob) return null;
    if (this.maps.has(blob)) return this.maps.get(blob)!;
    const plain = await readSignValue(this.ctx, blob);
    let map: Record<string, number> | null = null;
    if (plain !== null) {
      try {
        const parsed = JSON.parse(plain);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed as Record<string, number>;
      } catch {
        map = null;
      }
    }
    this.maps.set(blob, map);
    return map;
  }

  async total(blob: string | undefined): Promise<number | null> {
    if (!blob) return null;
    if (this.totals.has(blob)) return this.totals.get(blob)!;
    const plain = await readSignValue(this.ctx, blob);
    const n = plain === null ? NaN : Number(plain);
    const total = Number.isFinite(n) ? n : null;
    this.totals.set(blob, total);
    return total;
  }
}

/** Every subset sum of a list, with the subset as a bit mask. */
function subsetSums(values: number[]): { sum: number; mask: number }[] {
  let out = [{ sum: 0, mask: 0 }];
  values.forEach((v, i) => {
    out = out.concat(out.map((s) => ({ sum: s.sum + v, mask: s.mask | (1 << i) })));
  });
  return out;
}

/**
 * The explanations of one day's gap (see the header): every set of the
 * candidates whose values, counted the other way, close it. `count` caps at
 * MAX_EXPLANATIONS + 1; `only` is the one when there is exactly one, and
 * `involved` every candidate in any (all of them past the cap). Half and
 * half: each half's subset sums, matched through a map of the other's.
 */
export function explanations(values: readonly (readonly [string, number])[], gap: number): { count: number; only: Set<string> | null; involved: Set<string> } {
  const none = { count: 0, only: null, involved: new Set<string>() };
  if (gap % 2 !== 0) return none;
  const target = gap / 2;
  const half = Math.floor(values.length / 2);
  const left = subsetSums(values.slice(0, half).map(([, c]) => c));
  const right = subsetSums(values.slice(half).map(([, c]) => c));
  const bySum = new Map<number, number[]>();
  for (const r of right) bySum.set(r.sum, [...(bySum.get(r.sum) ?? []), r.mask]);
  let count = 0;
  let only = 0;
  let union = 0;
  for (const l of left) {
    for (const r of bySum.get(target - l.sum) ?? []) {
      const mask = l.mask | (r << half);
      if (++count === 1) only = mask;
      union |= mask;
      if (count > MAX_EXPLANATIONS) return { count, only: null, involved: new Set(values.map(([id]) => id)) };
    }
  }
  const ids = (mask: number) => new Set(values.filter((_, i) => (mask >> i) & 1).map(([id]) => id));
  return { count, only: count === 1 ? ids(only) : null, involved: ids(union) };
}

/**
 * How one day was counted for each candidate on it (see the header), from
 * its total and the breakdown it was written with, every account signed by
 * `types`. Only candidates holding a value other than 0 are labelled.
 */
function labelDay(breakdown: Record<string, unknown>, total: number | null, types: ReadonlyMap<string, string>, candidates: ReadonlySet<string>): Map<string, Label> {
  const present: string[] = [];
  let sum = 0;
  let unknown = total === null;
  const values: [string, number][] = [];
  for (const [k, v] of Object.entries(breakdown)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      unknown = true;
      continue;
    }
    if (cents(v) === 0) continue;
    if (candidates.has(k)) present.push(k);
    const type = types.get(k);
    if (!type) {
      unknown = true;
      continue;
    }
    const c = signed(type, v);
    sum += c;
    if (candidates.has(k)) values.push([k, cents(c)]);
  }
  const out = new Map<string, Label>();
  if (unknown || values.length > MAX_CANDIDATES) {
    for (const k of present) out.set(k, 'unknown');
    return out;
  }
  const { count, only, involved } = explanations(values, cents(sum) - cents(total!));
  for (const k of present) {
    if (count === 0) out.set(k, 'unknown');
    else if (count === 1) out.set(k, only!.has(k) ? 'flip' : 'ok');
    else out.set(k, involved.has(k) ? 'ambiguous' : 'ok');
  }
  return out;
}

/** Every account's type now, for each id `ids` names: the manual and tracked
 *  accounts' own, else the account directory's, else a lifecycle entry's,
 *  else a hidden entry's. An id none knows is left out (its days can't be
 *  told). */
async function typesNow(ctx: Ctx, ids: Iterable<string>): Promise<Map<string, string>> {
  const all = [...new Set(ids)];
  const [hidden, ends, directory, manual, tracked] = await Promise.all([
    getHiddenAccounts(ctx),
    lifecycleStore.getAll(ctx),
    directoryTypes(ctx, all),
    getManualAccounts(ctx),
    connectorAccountsStore.getAll(ctx),
  ]);
  const out = new Map<string, string>();
  for (const [id, e] of hidden) out.set(id, e.type);
  for (const [id, e] of ends) if (e.type) out.set(id, e.type);
  for (const [id, type] of Object.entries(directory)) if (type) out.set(id, type);
  for (const a of manual) out.set(a.account_id, a.type);
  for (const [id, a] of tracked) out.set(id, a.type);
  return out;
}

/** What one run reads: the layers, every account's type, the candidates, and
 *  every day's labels, worked out once for all of them. */
type Book = { layers: SignLayers; types: Map<string, string>; candidates: Set<string>; real: Map<string, Map<string, Label>>; est: Map<string, Map<string, Label>>; reading: Reading };

async function readBook(ctx: Ctx): Promise<Book> {
  const reading = new Reading(ctx);
  // Planned from the layers as they are: the legacy flat record is split off
  // only once a plan is accepted (execute).
  const layers = await readSignLayers(ctx, { split: false });
  const ids = new Set<string>();
  for (const l of LAYERS) for (const blob of Object.values(layers[l])) for (const k of Object.keys((await reading.map(blob)) ?? {})) ids.add(k);
  const [types, manual, tracked] = await Promise.all([typesNow(ctx, ids), getManualAccounts(ctx), connectorAccountsStore.ids(ctx)]);
  const candidates = new Set([...manual.map((a) => a.account_id), ...tracked]);
  const real = new Map<string, Map<string, Label>>();
  for (const [date, blob] of Object.entries(layers.r)) {
    const m = await reading.map(blob);
    real.set(date, m ? labelDay(m, await reading.total(layers.totals[date]), types, candidates) : new Map());
  }
  const est = new Map<string, Map<string, Label>>();
  for (const date of new Set([...Object.keys(layers.e), ...Object.keys(layers.f)])) {
    const walked = await reading.map(layers.e[date]);
    const flat = await reading.map(layers.f[date]);
    const readable = !(layers.e[date] && walked === null) && !(layers.f[date] && flat === null);
    const whole = { ...(walked ?? {}), ...(flat ?? {}) };
    const total = layers.estTotals[date] ? await reading.total(layers.estTotals[date]) : null;
    est.set(date, readable ? labelDay(whole, total, types, candidates) : new Map(Object.keys(whole).map((k) => [k, 'unknown' as Label])));
  }
  return { layers, types, candidates, real, est, reading };
}

/** Every value `id` has, by layer and day, labelled: the measured days
 *  (recorded and partial) in one series, the estimated ones (walked and
 *  flat) in another, and the ones walked past the estimate in a third. */
async function entriesOf(book: Book, id: string): Promise<Entry[][]> {
  const valueIn = (m: Record<string, number> | null) => (m && typeof m[id] === 'number' && Number.isFinite(m[id]) && cents(m[id]) !== 0 ? m[id] : null);
  const series: Entry[][] = [[], [], []];
  const add = async (n: number, layer: SignLayer, label: (date: string) => Label) => {
    for (const [date, blob] of Object.entries(book.layers[layer])) {
      const value = valueIn(await book.reading.map(blob));
      if (value !== null) series[n].push({ layer, date, value, label: label(date) });
    }
  };
  await add(0, 'r', (d) => book.real.get(d)?.get(id) ?? 'unknown');
  await add(0, 'p', () => 'unknown');
  await add(1, 'e', (d) => book.est.get(d)?.get(id) ?? 'unknown');
  await add(1, 'f', (d) => book.est.get(d)?.get(id) ?? 'unknown');
  await add(2, 'x', () => 'unknown');
  const byDate = (a: Entry, b: Entry) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.layer < b.layer ? -1 : 1);
  return series.map((s) => s.sort(byDate));
}

/** Each entry's status once its neighbours are read (see the header). */
function resolve(series: Entry[]): void {
  const proven = series.map((e, i) => (e.label === 'flip' || e.label === 'ok' ? i : -1)).filter((i) => i >= 0);
  for (let i = 0; i < series.length; i++) {
    const e = series[i];
    if (e.label === 'flip' || e.label === 'ok' || e.label === 'ambiguous') {
      e.status = e.label;
      continue;
    }
    const before = [...proven].reverse().find((j) => j < i);
    const after = proven.find((j) => j > i);
    const b = before === undefined ? null : series[before].label;
    const a = after === undefined ? null : series[after].label;
    if (b !== null && a !== null) e.status = b === a ? (b as Status) : 'boundary';
    else if (b === 'flip' || a === 'flip') e.status = 'edge';
    else e.status = 'undetermined';
  }
}

const planOf = (entries: Entry[]): SignPlan => {
  const plan: SignPlan = {};
  for (const e of entries) (plan[e.layer] ??= []).push([e.date, e.value]);
  return plan;
};
const countOf = (plan: SignPlan) => LAYERS.reduce((n, l) => n + (plan[l]?.length ?? 0), 0);
const daysOf = (entries: Entry[]) => [...new Set(entries.map((e) => e.date))].sort();

/** A repair's reading of one account: what it turns over, what it leaves,
 *  and the days that refuse it. */
async function repairReading(book: Book, id: string): Promise<{ plan: SignPlan; left: string[]; refused: string[] }> {
  const all = (await entriesOf(book, id)).flatMap((s) => {
    resolve(s);
    return s;
  });
  return {
    plan: planOf(all.filter((e) => e.status === 'flip')),
    left: daysOf(all.filter((e) => e.status === 'undetermined')),
    refused: daysOf(all.filter((e) => e.status === 'ambiguous' || e.status === 'boundary' || e.status === 'edge')),
  };
}

const refusal = (id: string, days: string[]) =>
  new SignRepairRefused(`The days ${id} was counted the other way can't be told exactly: nothing says how it was counted on ${days.join(', ')}.`, days);

/** A retype's plan, under the new kind (see the header): what it turns over,
 *  and the days it leaves. */
async function retypeReading(book: Book, id: string, job: SignJob, account: ConnectorAccount): Promise<{ plan: SignPlan; left: string[] }> {
  const day = job.at.slice(0, 10);
  const asOld = nyaBalance({ ...account, type: job.from as ConnectorAccount['type'] });
  const asNew = nyaBalance({ ...account, type: job.to as ConnectorAccount['type'] });
  const all = (await entriesOf(book, id)).flatMap((s) => {
    resolve(s);
    return s;
  });
  // The retype's own day: recorded just before it, in the old kind's sign.
  const recordedBefore = (e: Entry) =>
    e.date === day && (e.layer === 'r' || e.layer === 'p') && asOld !== null && asNew !== null && cents(e.value) === cents(asOld) && cents(e.value) !== cents(asNew);
  const turned = all.filter((e) => e.status === 'flip' || (e.status !== 'ok' && recordedBefore(e)));
  return { plan: planOf(turned), left: daysOf(all.filter((e) => e.status !== 'ok' && !turned.includes(e))) };
}

// ---- Running a job ----

/** Turns over what a plan names, each only while the account's value there
 *  is still the one planned (see the header); stops between days past
 *  `until`, answering what is left for the next run. */
async function execute(ctx: Ctx, id: string, job: SignJob, plan: SignPlan, until: number): Promise<{ negated: number; stopped: boolean }> {
  await splitLegacyFlat(ctx);
  let negated = 0;
  for (const layer of LAYERS) {
    for (const [date, value] of plan[layer] ?? []) {
      if (Date.now() > until) return { negated, stopped: true };
      if ((await negateAccountOn(ctx, layer, date, id, value, job.tag)) === 'done') negated++;
    }
  }
  return { negated, stopped: false };
}

/** The account's hidden and lifecycle entries take the kind it is read as
 *  now, which every day of it reads by once the job is done. */
async function retypeEntries(ctx: Ctx, id: string, to: string): Promise<void> {
  const hidden = (await getHiddenAccounts(ctx)).get(id);
  if (hidden && isOwedType(hidden.type) !== isOwedType(to)) await setHiddenType(ctx, id, to);
  await lifecycleStore.update(ctx, id, (e) => (e && e.type && isOwedType(e.type) !== isOwedType(to) ? { ...e, type: to } : e));
}

/** What running a job came to. */
export type JobOutcome = {
  negated: number;
  /** Days left as they were: nothing says how they were counted. */
  left: string[];
  /** Stopped at its time, to be finished by the next run. */
  pending?: true;
  /** Dropped, the account's kind no longer the one it was planned for. */
  abandoned?: string;
};

const sideWord = (type: string | null) => (type === null ? 'gone' : isOwedType(type) ? 'money owed' : 'money held');

/** The account's kind now: a tracked account's, else a manual one's. */
async function kindOf(ctx: Ctx, id: string): Promise<string | null> {
  return (await connectorAccountsStore.get(ctx, id))?.type ?? (await getManualAccount(ctx, id))?.type ?? null;
}

/** Drops a job whose account is no longer the kind it was planned for. */
async function abandon(ctx: Ctx, id: string, job: SignJob, now: string | null): Promise<JobOutcome> {
  await signJobStore.update(ctx, id, (cur) => (cur && cur.tag === job.tag ? null : cur));
  await dropFoldProgress(ctx, job.tag);
  const words = `The repair under way for ${id} was planned for it as ${sideWord(job.to)}, and it is ${sideWord(now)} now, so it was dropped and nothing more was turned over.`;
  console.error(`Balance signs: ${words}`);
  return { negated: 0, left: [], abandoned: words };
}

/** Runs one job, under the links lock held by the caller, until `until`: its
 *  retype first, then its plan, its entries, and its record gone. */
async function runLocked(ctx: Ctx, id: string, until: number): Promise<JobOutcome | null> {
  let job = await signJobStore.get(ctx, id);
  if (!job) return null;
  if ((await getHiddenAccounts(ctx)).get(id)?.forget_tag) {
    throw new SignRepairRefused(`${id} is being forgotten: finish that first.`, []);
  }
  if (!job.plan) {
    // A retype's own step: the kind changed, only while it is still the one
    // the job began from (or already the new one, from an earlier attempt).
    let account: ConnectorAccount | null = null;
    await connectorAccountsStore.update(ctx, id, (a) => {
      account = a && a.type === job!.from ? { ...a, type: job!.to as ConnectorAccount['type'], subtype: null } : a;
      return account;
    });
    const now = account as ConnectorAccount | null;
    if (!now || isOwedType(now.type) !== isOwedType(job.to)) return abandon(ctx, id, job, now?.type ?? null);
    const { plan, left } = await retypeReading(await readBook(ctx), id, job, now);
    const tag = job.tag;
    job = { ...job, plan, ...(left.length > 0 ? { left } : {}) };
    const saved = job;
    await signJobStore.update(ctx, id, (cur) => (cur && cur.tag === tag ? saved : cur));
  } else {
    // A saved plan runs only while the account is still the kind it was
    // planned for: changed back since (the release before's own change, with
    // no re-sign), its days are no longer the plan's.
    const now = await kindOf(ctx, id);
    if (now === null || isOwedType(now) !== isOwedType(job.to)) return abandon(ctx, id, job, now);
  }
  const { negated, stopped } = await execute(ctx, id, job, job.plan!, until);
  const left = job.left ?? [];
  if (stopped) return { negated, left, pending: true };
  await retypeEntries(ctx, id, job.to);
  const tag = job.tag;
  await signJobStore.update(ctx, id, (cur) => (cur && cur.tag === tag ? null : cur));
  await dropFoldProgress(ctx, tag);
  await clearCaches(ctx);
  return { negated, left };
}

/** Finishes one account's job, if it has one, within JOB_BUDGET_MS of the
 *  lock (or `until`, if sooner). */
export async function runSignJob(ctx: Ctx, id: string, until: number = Infinity): Promise<JobOutcome | null> {
  return withLinksLock(ctx, () => runLocked(ctx, id, Math.min(until, Date.now() + JOB_BUDGET_MS)));
}

/** What a change of a tracked account's kind came to: whether it changed,
 *  and its re-sign's outcome when there was one. */
export type RetypeOutcome = { changed: boolean; job: JobOutcome | null };

/**
 * Changes a tracked account's kind with its past turned over to match (see
 * the header): a job pending on it is finished first; then, read under the
 * lock, a change within one side is made alone, and one across is written
 * as a job before anything changes, and run.
 */
export async function retypeWithHistory(ctx: Ctx, id: string, to: string, opts: { now?: number; until?: number } = {}): Promise<RetypeOutcome> {
  const now = opts.now ?? Date.now();
  return withLinksLock(ctx, async () => {
    const until = Math.min(opts.until ?? Infinity, Date.now() + JOB_BUDGET_MS);
    const pending = await runLocked(ctx, id, until);
    if (pending?.pending) throw new SignRepairRefused(`${id} still has a repair under way: Nya’s next daily update finishes it.`, []);
    const account = await connectorAccountsStore.get(ctx, id);
    if (!account || account.type === to) return { changed: false, job: null };
    if (isOwedType(account.type) === isOwedType(to)) {
      await connectorAccountsStore.update(ctx, id, (a) => (a && isOwedType(a.type) === isOwedType(to) ? { ...a, type: to as ConnectorAccount['type'], subtype: null } : a));
      return { changed: (await connectorAccountsStore.get(ctx, id))?.type === to, job: null };
    }
    const job: SignJob = { v: 1, kind: 'retype', from: account.type, to, at: new Date(now).toISOString(), tag: `sign-${randomUUID()}` };
    await signJobStore.set(ctx, id, job);
    let outcome: JobOutcome | null;
    try {
      outcome = await runLocked(ctx, id, until);
    } catch (err) {
      // Failed before its kind changed: the job goes too, so nothing changes
      // the kind later behind the person's back (they are told it didn't).
      const cur = await connectorAccountsStore.get(ctx, id).catch(() => null);
      if (cur && cur.type !== to) await signJobStore.update(ctx, id, (j) => (j && j.tag === job.tag && !j.plan ? null : j)).catch(() => {});
      throw err;
    }
    return { changed: (await connectorAccountsStore.get(ctx, id))?.type === to, job: outcome };
  });
}

/** Every job still pending, finished: for the nightly snapshot, within
 *  JOB_BUDGET_MS in all (one past it is finished another night). A job that
 *  fails counts a night; past MAX_FAILED_NIGHTS it is left to the operator,
 *  whose dry run names it. Never throws. */
export async function finishSignJobs(ctx: Ctx): Promise<void> {
  const until = Date.now() + JOB_BUDGET_MS;
  let ids: string[];
  try {
    ids = await signJobStore.ids(ctx);
  } catch (err) {
    console.error('Balance signs: pending repairs could not be listed', err instanceof Error ? err.name : typeof err);
    return;
  }
  for (const id of ids) {
    if (Date.now() > until) return;
    try {
      const job = await signJobStore.get(ctx, id);
      if (!job || (job.failures ?? 0) >= MAX_FAILED_NIGHTS) continue;
      try {
        await runSignJob(ctx, id, until);
      } catch (err) {
        // Another change to accounts holds the lock: tried again tomorrow.
        if (err instanceof ForgetRefused) continue;
        const kind = err instanceof Error ? err.name : typeof err;
        await signJobStore.update(ctx, id, (cur) => (cur && cur.tag === job.tag ? { ...cur, failures: (cur.failures ?? 0) + 1, error: kind.slice(0, 80) } : cur));
        console.error(`Balance signs: a pending repair could not be finished (${kind})`);
      }
    } catch (err) {
      console.error('Balance signs: a pending repair could not be read', err instanceof Error ? err.name : typeof err);
    }
  }
}

// ---- The operator's repair ----

/** What a dry run says of one account: ids, days and counts, never an
 *  amount or a name. */
export type SignFinding = {
  account_id: string;
  /** 'gone' for a job whose account is neither any more (its next run drops it). */
  source: 'manual' | 'tracked' | 'gone';
  type: string;
  /** How many values a repair would turn over, by layer. */
  days: Partial<Record<SignLayer, number>>;
  first: string | null;
  last: string | null;
  /** Why it can't be repaired as it stands: the days nothing tells. */
  refused?: { days: string[]; reason: string };
  /** Days nothing says how they were counted, left as they are. */
  undetermined?: { count: number; days: string[] };
  /** A job already under way on it, and how it has gone: `stopped` once the
   *  nightly job has stopped trying it (MAX_FAILED_NIGHTS). */
  pending?: { kind: SignJob['kind']; failures: number; error: string | null; stopped: boolean };
};

const firstDays = (days: string[]) => days.slice(0, 10);

/** The dry run: every manual and tracked account some day of whose history
 *  the totals prove (or its neighbours say) was counted the other way, or
 *  can't be told, and every job under way. Writes nothing. */
export async function findSignFlips(ctx: Ctx): Promise<SignFinding[]> {
  const [manual, tracked, pendingIds] = await Promise.all([getManualAccounts(ctx), connectorAccountsStore.getAll(ctx), signJobStore.ids(ctx)]);
  const candidates: [string, SignFinding['source']][] = [...tracked.keys()].map((id) => [id, 'tracked'] as [string, 'tracked']);
  for (const a of manual) if (!tracked.has(a.account_id)) candidates.push([a.account_id, 'manual']);
  for (const id of pendingIds) if (!candidates.some(([c]) => c === id)) candidates.push([id, 'gone']);
  const book = await readBook(ctx);
  const out: SignFinding[] = [];
  for (const [id, source] of candidates.sort(([a], [b]) => (a < b ? -1 : 1))) {
    const job = pendingIds.includes(id) ? await signJobStore.get(ctx, id) : null;
    const pending = job ? { pending: { kind: job.kind, failures: job.failures ?? 0, error: job.error ?? null, stopped: (job.failures ?? 0) >= MAX_FAILED_NIGHTS } } : {};
    const reading = await repairReading(book, id);
    const { left, refused } = reading;
    // Refused, a repair turns nothing over.
    const plan = refused.length > 0 ? {} : reading.plan;
    if (countOf(plan) === 0 && left.length === 0 && refused.length === 0 && !job) continue;
    const dates = LAYERS.flatMap((l) => (plan[l] ?? []).map(([d]) => d)).sort();
    out.push({
      account_id: id,
      source,
      type: book.types.get(id) ?? '',
      days: Object.fromEntries(LAYERS.filter((l) => plan[l]?.length).map((l) => [l, plan[l]!.length])),
      first: dates[0] ?? null,
      last: dates.at(-1) ?? null,
      ...(refused.length > 0 ? { refused: { days: refused, reason: refusal(id, refused).message } } : {}),
      ...(left.length > 0 ? { undetermined: { count: left.length, days: firstDays(left) } } : {}),
      ...pending,
    });
  }
  return out;
}

/**
 * Repairs one account flipped under an older release (see the header), or
 * finishes its job if one is pending: planned, written, then run, under the
 * links lock throughout. SignRepairRefused when a day can't be told, writing
 * nothing; 0 turned over when there is nothing to repair.
 */
export async function repairSignFlip(ctx: Ctx, id: string, now: number = Date.now()): Promise<JobOutcome> {
  return withLinksLock(ctx, async () => {
    const until = Date.now() + JOB_BUDGET_MS;
    const pending = await runLocked(ctx, id, until);
    if (pending) return pending;
    const [manual, tracked] = await Promise.all([getManualAccounts(ctx), connectorAccountsStore.has(ctx, id)]);
    if (!tracked && !manual.some((a) => a.account_id === id)) {
      throw new SignRepairRefused(`${id} is neither a manual account nor one SimpleFIN or Lunch Flow keeps up to date: only those are repaired here.`, []);
    }
    const book = await readBook(ctx);
    const { plan, left, refused } = await repairReading(book, id);
    if (refused.length > 0) throw refusal(id, refused);
    if (countOf(plan) === 0) return { negated: 0, left };
    const type = book.types.get(id)!;
    await signJobStore.set(ctx, id, { v: 1, kind: 'repair', from: type, to: type, at: new Date(now).toISOString(), tag: `sign-${randomUUID()}`, plan, ...(left.length > 0 ? { left } : {}) });
    return (await runLocked(ctx, id, until)) ?? { negated: 0, left };
  });
}

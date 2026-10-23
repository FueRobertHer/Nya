// lib/sign-repair.ts
//
// Re-signing one account's past balances when the kind it is read as crossed
// between money held and money owed (designs: owed-flip, sign-repair).
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
//            it (lib/manual-account-writes.ts OWED_FLIP): the same number,
//            read the other way from the flip on.
//
// THE TOTALS SAY HOW EACH DAY WAS COUNTED. On a day with a total, every
// value in its breakdown signed by its account's type now adds up to the
// total ('ok'); or it falls short by exactly twice one account's signed value
// and by no other's ('flip': that account was counted the other way that
// day); or anything else ('unknown': the gap is no one account's, an account
// in it has no known type, something can't be read, or there is no total,
// as on a partial day). Estimated days the same, against the estimated total,
// the walked map and that day's flat record. A value of 0 needs no decision.
//
// ONE MECHANISM. A job (the `sign-repairs` store, by account id) plans the
// layer and day of each value to negate, with a digest of the stored map it
// was planned on, and negates each in one compare-and-set while that map is
// still the one planned on (lib/history.ts negateAccountOn), progress marked
// under the job's tag. Every total stays as recorded. A value negated
// already, or rewritten since (a later recording, a rebuilt estimate), no
// longer matches its digest, so nothing is ever negated twice and a job cut
// off part way is finished by running it again: by the request that started
// it, by the nightly snapshot (finishSignJobs), or by the operator. The
// account's hidden and lifecycle entries take its type now, which their
// subtraction reads every day by. Under the links lock, as a fold is.
//
//   RETYPE   the job is written before the kind changes, and the change is
//            its first step. Planned under the new kind: a 'flip' day is
//            negated, an 'ok' one kept (an older retype is put right so), an
//            'unknown' one before the retype's day negated, so it reads as it
//            did; today's value without a total that proves it is compared
//            with the account's balance under each kind, and negated only
//            when it is the old kind's. It never refuses.
//   REPAIR   'flip' days are negated; an 'unknown' day takes the label of
//            its nearest decided days when both agree, and is left alone
//            past the last or before the first decided day when that one is
//            'ok'. Anything else means the day it flipped can't be found
//            exactly: refused, naming the days, and nothing is written.
//            Run by the operator (app/api/ops/sign-repair), after a dry run.
//
// THE RELEASE BEFORE reads every value with the type its account has now,
// as this one does: no reader changes, and no stored shape. It ignores this
// store, so a job still pending under a rollback leaves its account read as
// it always was there until this release finishes it.

import { createHash, randomUUID } from 'node:crypto';
import type { Ctx } from './containers';
import { isOwedType } from './balance';
import { dropFoldProgress, negateAccountOn, readSignLayers, readSignValue, type SignLayer, type SignLayers } from './history';
import { getHiddenAccounts, setHiddenType } from './hidden';
import { lifecycleStore } from './lifecycle';
import { directoryTypes, withLinksLock } from './links';
import { getManualAccounts } from './manual';
import { connectorAccountsStore, type ConnectorAccount } from './connectors/store';
import { nyaBalance } from './connectors/institutions';
import { clearCaches } from './cache';
import { SIGN_LAYERS, signJobStore, type SignJob, type SignPlan } from './sign-repair-store';

export { signJobStore, type SignJob, type SignPlan };

const LAYERS = SIGN_LAYERS;

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

type Label = 'ok' | 'flip' | 'unknown';
type Entry = { layer: SignLayer; date: string; blob: string; label: Label; value: number };

const cents = (n: number) => Math.round(n * 100);
const digestOf = (blob: string) => createHash('sha256').update(blob, 'utf8').digest('hex').slice(0, 16);

/** A map as stored, decrypted, or null when it can't be read for good. */
async function mapOf(ctx: Ctx, blob: string | undefined, cache: Map<string, Record<string, number> | null>): Promise<Record<string, number> | null> {
  if (!blob) return null;
  if (cache.has(blob)) return cache.get(blob)!;
  const plain = await readSignValue(ctx, blob);
  let map: Record<string, number> | null = null;
  if (plain !== null) {
    try {
      const parsed = JSON.parse(plain);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed as Record<string, number>;
    } catch {
      map = null;
    }
  }
  cache.set(blob, map);
  return map;
}

/** A total as stored, or null when it can't be read for good; each read
 *  once a run, as the maps are. */
const TOTALS = new WeakMap<Map<string, Record<string, number> | null>, Map<string, number | null>>();
async function totalOf(ctx: Ctx, blob: string | undefined, cache: Map<string, Record<string, number> | null>): Promise<number | null> {
  if (!blob) return null;
  let totals = TOTALS.get(cache);
  if (!totals) TOTALS.set(cache, (totals = new Map()));
  if (totals.has(blob)) return totals.get(blob)!;
  const plain = await readSignValue(ctx, blob);
  const n = plain === null ? NaN : Number(plain);
  const total = Number.isFinite(n) ? n : null;
  totals.set(blob, total);
  return total;
}

/**
 * How one day was counted for `id` (see the header), from its total and the
 * breakdown it was written with, every account signed by `types`.
 */
function labelOf(breakdown: Record<string, unknown>, total: number | null, id: string, types: ReadonlyMap<string, string>): Label {
  if (total === null) return 'unknown';
  let sum = 0;
  const twice = new Map<string, number>();
  for (const [k, v] of Object.entries(breakdown)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'unknown';
    if (cents(v) === 0) continue;
    const type = types.get(k);
    if (!type) return 'unknown';
    const c = isOwedType(type) ? -v : v;
    sum += c;
    twice.set(k, 2 * cents(c));
  }
  const gap = cents(sum) - cents(total);
  if (gap === 0) return 'ok';
  const by = [...twice].filter(([, c2]) => c2 === gap).map(([k]) => k);
  return by.length === 1 && by[0] === id ? 'flip' : 'unknown';
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

/**
 * Every value `id` has, by layer and day, each labelled by what its day's
 * totals say: the measured days (recorded and partial) in one series, the
 * estimated ones (walked and flat) in another, and the ones walked past the
 * estimate in a third, with no totals.
 */
async function entriesOf(ctx: Ctx, layers: SignLayers, id: string, types: ReadonlyMap<string, string>, cache: Map<string, Record<string, number> | null>): Promise<{ measured: Entry[]; estimated: Entry[]; beyond: Entry[] }> {
  const measured: Entry[] = [];
  const estimated: Entry[] = [];
  const beyond: Entry[] = [];
  const valueIn = (m: Record<string, number> | null) => (m && typeof m[id] === 'number' && Number.isFinite(m[id]) && cents(m[id]) !== 0 ? m[id] : null);
  for (const [date, blob] of Object.entries(layers.r)) {
    const m = await mapOf(ctx, blob, cache);
    const value = valueIn(m);
    if (value === null) continue;
    measured.push({ layer: 'r', date, blob, value, label: labelOf(m!, await totalOf(ctx, layers.totals[date], cache), id, types) });
  }
  for (const [date, blob] of Object.entries(layers.p)) {
    const value = valueIn(await mapOf(ctx, blob, cache));
    if (value !== null) measured.push({ layer: 'p', date, blob, value, label: 'unknown' });
  }
  for (const layer of ['e', 'f'] as const) {
    for (const [date, blob] of Object.entries(layers[layer])) {
      const m = await mapOf(ctx, blob, cache);
      const value = valueIn(m);
      if (value === null) continue;
      // The day's whole estimate: the walked map and the flat record together.
      const walked = await mapOf(ctx, layers.e[date], cache);
      const flat = await mapOf(ctx, layers.f[date], cache);
      const whole = walked === null && layers.e[date] ? null : flat === null && layers.f[date] ? null : { ...(walked ?? {}), ...(flat ?? {}) };
      const total = layers.estTotals[date] ? await totalOf(ctx, layers.estTotals[date], cache) : null;
      estimated.push({ layer, date, blob, value, label: whole ? labelOf(whole, total, id, types) : 'unknown' });
    }
  }
  for (const [date, blob] of Object.entries(layers.x)) {
    const value = valueIn(await mapOf(ctx, blob, cache));
    if (value !== null) beyond.push({ layer: 'x', date, blob, value, label: 'unknown' });
  }
  const byDate = (a: Entry, b: Entry) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.layer < b.layer ? -1 : 1);
  return { measured: measured.sort(byDate), estimated: estimated.sort(byDate), beyond: beyond.sort(byDate) };
}

/**
 * A repair's labels for one series: each 'unknown' entry takes the label of
 * its nearest decided entries when both agree, and is left ('ok') past the
 * last or before the first decided one when that one is 'ok', or when none is
 * decided at all. Answers the days that can't be told (refused).
 */
function resolve(series: Entry[]): string[] {
  const refused: string[] = [];
  const decided = series.map((e, i) => (e.label === 'unknown' ? -1 : i)).filter((i) => i >= 0);
  for (let i = 0; i < series.length; i++) {
    const e = series[i];
    if (e.label !== 'unknown') continue;
    const before = [...decided].reverse().find((j) => j < i);
    const after = decided.find((j) => j > i);
    const b = before === undefined ? null : series[before].label;
    const a = after === undefined ? null : series[after].label;
    if (b === null && a === null) e.label = 'ok';
    else if (b !== null && a !== null) {
      if (b === a) e.label = b;
      else refused.push(e.date);
    } else if ((b ?? a) === 'ok') e.label = 'ok';
    else refused.push(e.date);
  }
  return refused;
}

const planOf = (entries: Entry[]): SignPlan => {
  const plan: SignPlan = {};
  for (const e of entries) (plan[e.layer] ??= []).push([e.date, digestOf(e.blob)]);
  return plan;
};
const countOf = (plan: SignPlan) => LAYERS.reduce((n, l) => n + (plan[l]?.length ?? 0), 0);

/** All the ids every map names, for their types. */
async function idsIn(ctx: Ctx, layers: SignLayers, cache: Map<string, Record<string, number> | null>): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const l of LAYERS) for (const blob of Object.values(layers[l])) for (const k of Object.keys((await mapOf(ctx, blob, cache)) ?? {})) ids.add(k);
  return ids;
}

/** A repair's plan for one account: its days counted the other way, or the
 *  days that can't be told (SignRepairRefused). */
async function repairPlan(ctx: Ctx, layers: SignLayers, id: string, types: ReadonlyMap<string, string>, cache: Map<string, Record<string, number> | null>): Promise<SignPlan> {
  const { measured, estimated, beyond } = await entriesOf(ctx, layers, id, types, cache);
  const refused = [...resolve(measured), ...resolve(estimated), ...resolve(beyond)];
  if (refused.length > 0) {
    const days = [...new Set(refused)].sort();
    throw new SignRepairRefused(`The day ${id} was counted the other way from can't be found exactly: nothing says how it was counted on ${days.join(', ')}.`, days);
  }
  return planOf([...measured, ...estimated, ...beyond].filter((e) => e.label === 'flip'));
}

/** A retype's plan, under the new kind (see the header). */
async function retypePlan(ctx: Ctx, layers: SignLayers, id: string, job: SignJob, account: ConnectorAccount, types: ReadonlyMap<string, string>, cache: Map<string, Record<string, number> | null>): Promise<SignPlan> {
  const { measured, estimated, beyond } = await entriesOf(ctx, layers, id, types, cache);
  const day = job.at.slice(0, 10);
  const asOld = nyaBalance({ ...account, type: job.from as ConnectorAccount['type'] });
  const asNew = nyaBalance({ ...account, type: job.to as ConnectorAccount['type'] });
  const negate = (e: Entry): boolean => {
    if (e.label !== 'unknown') return e.label === 'flip';
    if (e.layer === 'r' || e.layer === 'p') {
      if (e.date < day) return true;
      // The retype's own day: recorded before it or after, by its balance.
      return asOld !== null && asNew !== null && cents(e.value) === cents(asOld) && cents(e.value) !== cents(asNew);
    }
    return true;
  };
  return planOf([...measured, ...estimated, ...beyond].filter(negate));
}

// ---- Running a job ----

/** Negates what a plan names, each only while its map is the one planned on. */
async function execute(ctx: Ctx, id: string, job: SignJob, plan: SignPlan): Promise<number> {
  const layers = await readSignLayers(ctx, { split: true });
  let done = 0;
  for (const layer of LAYERS) {
    for (const [date, digest] of plan[layer] ?? []) {
      const blob = layers[layer][date];
      if (!blob || digestOf(blob) !== digest) continue;
      if ((await negateAccountOn(ctx, layer, date, id, blob, job.tag)) === 'done') done++;
    }
  }
  return done;
}

/** The account's hidden and lifecycle entries take the kind it is read as
 *  now, which every day of it reads by once the job is done. */
async function retypeEntries(ctx: Ctx, id: string, to: string): Promise<void> {
  const hidden = (await getHiddenAccounts(ctx)).get(id);
  if (hidden && isOwedType(hidden.type) !== isOwedType(to)) await setHiddenType(ctx, id, hidden, to);
  await lifecycleStore.update(ctx, id, (e) => (e && e.type && isOwedType(e.type) !== isOwedType(to) ? { ...e, type: to } : e));
}

/** Runs one job, under the links lock held by the caller: its retype first,
 *  then its plan, its entries, and its record and progress gone. */
async function runLocked(ctx: Ctx, id: string): Promise<{ negated: number } | null> {
  const job = await signJobStore.get(ctx, id);
  if (!job) return null;
  if ((await getHiddenAccounts(ctx)).get(id)?.forget_tag) {
    throw new SignRepairRefused(`${id} is being forgotten: finish that first.`, []);
  }
  let plan = job.plan;
  if (!plan) {
    // A retype's own step: the kind changed, only while it is still the one
    // the job began from (or already the new one, from an earlier attempt).
    let account: ConnectorAccount | null = null;
    await connectorAccountsStore.update(ctx, id, (a) => {
      account = a;
      if (!a || a.type !== job.from) return a;
      account = { ...a, type: job.to as ConnectorAccount['type'], subtype: null };
      return account;
    });
    const now = account as ConnectorAccount | null;
    if (!now || isOwedType(now.type) !== isOwedType(job.to)) {
      // Gone, or changed back since without this release: nothing to re-sign.
      await signJobStore.remove(ctx, id);
      await dropFoldProgress(ctx, job.tag);
      return { negated: 0 };
    }
    const cache = new Map<string, Record<string, number> | null>();
    const layers = await readSignLayers(ctx, { split: true });
    const types = await typesNow(ctx, await idsIn(ctx, layers, cache));
    plan = await retypePlan(ctx, layers, id, job, now, types, cache);
    const planned = plan;
    await signJobStore.update(ctx, id, (cur) => (cur && cur.tag === job.tag ? { ...cur, plan: planned } : cur));
  }
  const negated = await execute(ctx, id, job, plan);
  await retypeEntries(ctx, id, job.to);
  await signJobStore.update(ctx, id, (cur) => (cur && cur.tag === job.tag ? null : cur));
  await dropFoldProgress(ctx, job.tag);
  await clearCaches(ctx);
  return { negated };
}

/** Finishes one account's job, if it has one. */
export async function runSignJob(ctx: Ctx, id: string): Promise<{ negated: number } | null> {
  return withLinksLock(ctx, () => runLocked(ctx, id));
}

/**
 * Changes a tracked account's kind across money held and owed with its past
 * re-signed (see the header): a job pending on it is finished first, then
 * this one is written before anything changes and run. Answers whether the
 * kind changed.
 */
export async function retypeWithHistory(ctx: Ctx, id: string, to: string, now: number = Date.now()): Promise<boolean> {
  return withLinksLock(ctx, async () => {
    await runLocked(ctx, id);
    // Its kind as it is now, under the lock: another change may have landed
    // since the caller read it, and a job is only for a change across.
    const account = await connectorAccountsStore.get(ctx, id);
    if (!account) return false;
    if (isOwedType(account.type) === isOwedType(to)) {
      if (account.type === to) return false;
      await connectorAccountsStore.update(ctx, id, (a) => (a && isOwedType(a.type) === isOwedType(to) ? { ...a, type: to as ConnectorAccount['type'], subtype: null } : a));
      return true;
    }
    const job: SignJob = { v: 1, kind: 'retype', from: account.type, to, at: new Date(now).toISOString(), tag: `sign-${randomUUID()}` };
    await signJobStore.set(ctx, id, job);
    await runLocked(ctx, id);
    return (await connectorAccountsStore.get(ctx, id))?.type === to;
  });
}

/** Every job still pending, finished: for the nightly snapshot. Never
 *  throws: one that fails is logged, and stays for the next night. */
export async function finishSignJobs(ctx: Ctx): Promise<void> {
  let ids: string[];
  try {
    ids = await signJobStore.ids(ctx);
  } catch (err) {
    console.error('Balance signs: pending repairs could not be listed', err instanceof Error ? err.name : typeof err);
    return;
  }
  for (const id of ids) {
    try {
      await runSignJob(ctx, id);
    } catch (err) {
      console.error('Balance signs: a pending repair could not be finished', err instanceof Error ? err.name : typeof err);
    }
  }
}

// ---- The operator's repair ----

/** What a dry run says of one account counted the other way on some days:
 *  ids, days and counts, never an amount or a name. */
export type SignFinding = {
  account_id: string;
  source: 'manual' | 'tracked';
  type: string;
  /** How many values would be negated, by layer. */
  days: Partial<Record<SignLayer, number>>;
  first: string | null;
  last: string | null;
  /** Why it can't be repaired as it stands: the days nothing says. */
  refused?: { days: string[]; reason: string };
  /** A job already under way on it. */
  pending?: true;
};

/** The dry run: every manual and tracked account some day of whose history
 *  was counted the other way, or can't be told. Writes nothing. */
export async function findSignFlips(ctx: Ctx): Promise<SignFinding[]> {
  const [manual, tracked, pending] = await Promise.all([getManualAccounts(ctx), connectorAccountsStore.getAll(ctx), signJobStore.ids(ctx)]);
  const candidates: [string, 'manual' | 'tracked'][] = [...tracked.keys()].map((id) => [id, 'tracked'] as [string, 'tracked']);
  for (const a of manual) if (!tracked.has(a.account_id)) candidates.push([a.account_id, 'manual']);
  const cache = new Map<string, Record<string, number> | null>();
  const layers = await readSignLayers(ctx, { split: false });
  const types = await typesNow(ctx, await idsIn(ctx, layers, cache));
  const out: SignFinding[] = [];
  for (const [id, source] of candidates.sort(([a], [b]) => (a < b ? -1 : 1))) {
    const type = types.get(id) ?? '';
    const base = { account_id: id, source, type, ...(pending.includes(id) ? { pending: true as const } : {}) };
    try {
      const plan = await repairPlan(ctx, layers, id, types, cache);
      if (countOf(plan) === 0 && !base.pending) continue;
      const dates = LAYERS.flatMap((l) => (plan[l] ?? []).map(([d]) => d)).sort();
      out.push({ ...base, days: Object.fromEntries(LAYERS.filter((l) => plan[l]?.length).map((l) => [l, plan[l]!.length])), first: dates[0] ?? null, last: dates.at(-1) ?? null });
    } catch (err) {
      if (!(err instanceof SignRepairRefused)) throw err;
      out.push({ ...base, days: {}, first: null, last: null, refused: { days: err.days, reason: err.message } });
    }
  }
  return out;
}

/**
 * Repairs one account flipped under an older release (see the header), or
 * finishes its job if one is pending: planned, written, then run, under the
 * links lock throughout. SignRepairRefused when a day can't be told; 0
 * negated when there is nothing to repair.
 */
export async function repairSignFlip(ctx: Ctx, id: string, now: number = Date.now()): Promise<{ negated: number }> {
  return withLinksLock(ctx, async () => {
    const pending = await runLocked(ctx, id);
    if (pending) return pending;
    const [manual, tracked] = await Promise.all([getManualAccounts(ctx), connectorAccountsStore.has(ctx, id)]);
    if (!tracked && !manual.some((a) => a.account_id === id)) {
      throw new SignRepairRefused(`${id} is neither a manual account nor one SimpleFIN or Lunch Flow keeps up to date: only those are repaired here.`, []);
    }
    const cache = new Map<string, Record<string, number> | null>();
    const layers = await readSignLayers(ctx, { split: true });
    const types = await typesNow(ctx, await idsIn(ctx, layers, cache));
    const type = types.get(id)!;
    const plan = await repairPlan(ctx, layers, id, types, cache);
    if (countOf(plan) === 0) return { negated: 0 };
    await signJobStore.set(ctx, id, { v: 1, kind: 'repair', from: type, to: type, at: new Date(now).toISOString(), tag: `sign-${randomUUID()}`, plan });
    return (await runLocked(ctx, id)) ?? { negated: 0 };
  });
}

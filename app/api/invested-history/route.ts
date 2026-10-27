import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { getEffectiveHidden, readKnownAccounts } from '@/lib/links';
import { placeRecorded } from '@/lib/holdings-history';
import { readMeasuredBalances } from '@/lib/history';
import { getEffectiveLifecycle, endDays, endOf } from '@/lib/lifecycle';
import { isInvestmentType } from '@/lib/balance';
import { isManualId, MANUAL_CURRENCY } from '@/lib/manual';
import { bankCurrencies } from '@/lib/sharing';
import { readFx } from '@/lib/fx/read';
import { savedPlanStore } from '@/lib/saved-plan';
import { investedSeries, isComplete, type InvestedSeriesAccount, type InvestedDay } from '@/lib/fire/invested-series';

// Invested assets day by day since the plan the person saved as their plan
// (lib/fire/saved-plan.ts), for the Plan tab's Progress card and the line on
// Your path's chart: each day snapshots measured balances on (lib/history.ts
// readMeasuredBalances, never an estimate), the accounts the Plan counts,
// summed by its rules (lib/fire/invested-series.ts). Reads stored data only,
// no Plaid calls, and writes nothing.
//
//   POST /api/invested-history
//     { accounts: [{ account_id, type, currency }] }
//   -> { currency, saved_day, anchor, latest,
//        months: [{ date, total }],
//        accounts: [{ account_id, first, last, ended, label }],
//        unreadable_days }
//
// `accounts` is every account the dashboard knows, hidden ones aside, with
// its type and currency (lib/fire/invested-series.ts progressAccountsOf):
// those it shows and those an institution is known to have but can't show.
// A POST because that list is the question and can be longer than a URL.
// What counts comes from the SAVED PLAN, read here, never from the page:
// investment accounts, and checking and savings when it was saved with
// include cash; summed in its currency; from the day it was saved. So both
// ends of the comparison are counted by the same rules.
//
// Ids are followed through account links, one balance per account a day
// (the id its history would be read from first, never two), and every id of
// a hidden account is left out, as everywhere. An account that ENDED
// (lib/lifecycle.ts) counts on the days before its end, whether or not the
// page still lists it. An account the page doesn't list and that didn't end
// (its connection removed) is in no day: the same at both ends.
//
// The answer, from the saved day to today (UTC days, as snapshots'):
//   - `anchor`: the first COMPLETE day (every account expected that day
//     measured, nothing left out for its currency), which the plan grows
//     from; null until there is one;
//   - `latest`: the newest day measured, complete or not, with what it
//     misses, so a short total is said rather than set against the plan;
//   - `months`: the last complete day of each month from the anchor on, for
//     a line a point a month;
//   - `accounts`: when each counted account was first and last measured in
//     that time, the day it ended (null for none), and the directory's name
//     for one (lib/links.ts), so the page can name what is missing, what was
//     added since the anchor, and what ended since, which is in the start
//     and not after.
// A day whose balances are damaged for good is named (`unreadable_days`),
// never a day with no balances. 404 with no saved plan; errors as on the
// storage seam (lib/store-failure.ts).

/** More accounts than anyone has: a list longer is not one from the Plan tab. */
const MAX_ACCOUNTS = 500;
/** The longest body a list of MAX_ACCOUNTS takes, with room. */
const MAX_BODY_CHARS = 200_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENCY = /^[A-Z0-9]{2,12}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_:.=-]{1,128}$/;
const TYPE = /^[a-z_ ]{1,40}$/;

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The calendar months [from, to] touches, each as the part of the range in it. */
function monthRanges(from: string, to: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let start = from;
  while (start <= to) {
    const [y, m] = start.split('-').map(Number);
    const last = dayOf(Date.UTC(y, m, 0));
    out.push({ from: start, to: last < to ? last : to });
    start = dayOf(Date.UTC(y, m, 1));
  }
  return out;
}

/** Every UTC day in [from, to]. */
function daysIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); dayOf(t) <= to; t += DAY_MS) out.push(dayOf(t));
  return out;
}

type Listed = { account_id: string; type: string; currency: string | null };

/** The question, strictly: exactly `accounts`, each well formed, or why not. */
function parseQuestion(body: unknown): Listed[] | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Send a JSON object';
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => k !== 'accounts');
  if (extra) return `${extra.slice(0, 40)} isn’t taken here`;
  if (!Array.isArray(b.accounts)) return 'accounts is a list of the accounts the dashboard knows';
  if (b.accounts.length > MAX_ACCOUNTS) return `At most ${MAX_ACCOUNTS} accounts`;
  const out: Listed[] = [];
  const seen = new Set<string>();
  for (const raw of b.accounts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Each account is an object';
    const a = raw as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== 3 || !['account_id', 'type', 'currency'].every((k) => keys.includes(k))) return 'Each account has account_id, type and currency';
    if (typeof a.account_id !== 'string' || !ACCOUNT_ID.test(a.account_id)) return 'An account_id is not one';
    if (typeof a.type !== 'string' || !TYPE.test(a.type)) return 'An account’s type is a word, such as investment';
    if (a.currency !== null && !(typeof a.currency === 'string' && CURRENCY.test(a.currency))) return "An account's currency is a currency code, or null";
    if (seen.has(a.account_id)) return 'Each account once';
    seen.add(a.account_id);
    out.push({ account_id: a.account_id, type: a.type, currency: a.currency as string | null });
  }
  return out;
}

export async function POST(req: Request) {
  const text = await req.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_CHARS) return bad('Send the accounts, as JSON');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad('Send the accounts, as JSON');
  }
  const listedIn = parseQuestion(body);
  if (typeof listedIn === 'string') return bad(listedIn);

  try {
    const ctx = await dataCtx();
    // Strict: a saved plan that can't be read is a 409, never "none".
    const saved = await savedPlanStore.get(ctx);
    if (saved === null) return NextResponse.json({ error: 'No plan is saved as your plan.' }, { status: 404 });
    const counts = (type: string | null) => type !== null && (isInvestmentType(type) || (saved.plan.includeCash && type === 'depository'));
    const today = dayOf(Date.now());
    const from = saved.day;

    const effective = await getEffectiveHidden(ctx);
    const place = placeRecorded({ links: effective.links ?? undefined, hidden: effective.hidden });
    const [directory, lifecycle] = await Promise.all([readKnownAccounts(ctx), getEffectiveLifecycle(ctx, effective.links)]);
    const ends = endDays(lifecycle);

    // The accounts that count, under the ids they are known by now, hidden
    // ones left out.
    const listed = new Map<string, { account_id: string; currency: string | null; ended?: string }>();
    for (const a of listedIn) {
      if (!counts(a.type)) continue;
      const placed = place(a.account_id);
      if (!placed || listed.has(placed.account)) continue;
      const end = ends.get(placed.account);
      listed.set(placed.account, { account_id: placed.account, currency: a.currency, ...(end !== undefined ? { ended: end } : {}) });
    }
    // An account that ended which would count, up to its end, in its own
    // currency: as its end recorded it, else as its institution last
    // reported it (a display convenience: one that can't be read is none), a
    // manual one's in the one its end recorded, else US dollars, as
    // allocation over time prices them.
    const added: { account: string; end: string; currency: string | null; ids: string[] }[] = [];
    for (const [root, { entry }] of lifecycle.accounts) {
      const end = endOf(entry.lifecycle);
      if (end === null || !counts(entry.type ?? null)) continue;
      const placed = place(root);
      if (!placed || listed.has(placed.account) || added.some((a) => a.account === placed.account)) continue;
      added.push({ account: placed.account, end, currency: entry.currency ?? (isManualId(placed.account) ? MANUAL_CURRENCY : null), ids: [...new Set([root, placed.account])] });
    }
    const unpriced = added.filter((a) => a.currency === null).flatMap((a) => a.ids);
    const reported = unpriced.length > 0 ? await bankCurrencies(ctx, unpriced).catch(() => new Map<string, string>()) : new Map<string, string>();
    for (const a of added) {
      const currency = a.currency ?? a.ids.map((id) => reported.get(id)).find((c) => c !== undefined) ?? null;
      listed.set(a.account, { account_id: a.account, currency, ended: a.end });
    }

    // When the directory first knew each, the earliest of its ids, and its
    // name. One whose entry can't be read is expected from the start: no day
    // is taken for complete without it.
    const knownFrom = new Map<string, string>();
    const labels = new Map<string, string>();
    for (const [id, k] of directory.known) {
      const placed = place(id);
      if (!placed || !listed.has(placed.account)) continue;
      if (k.first_seen) {
        const prev = knownFrom.get(placed.account);
        if (!prev || k.first_seen < prev) knownFrom.set(placed.account, k.first_seen);
      }
      if (k.label && !labels.has(placed.account)) labels.set(placed.account, k.label);
    }
    for (const id of directory.unreadable) {
      const placed = place(id);
      if (placed && listed.has(placed.account)) knownFrom.set(placed.account, '0000-01-01');
    }

    const accounts: InvestedSeriesAccount[] = [...listed.values()].map((a) => ({ ...a, knownFrom: knownFrom.get(a.account_id) ?? null }));
    const currencies = new Set(accounts.map((a) => a.currency).filter((c): c is string => c !== null));
    if (saved.currency) currencies.add(saved.currency);
    const { fx } = await readFx(ctx, { currencies, from, to: today });
    const series = investedSeries({ accounts, currency: saved.currency, fx: fx.home ? fx : null });

    const unreadableDays: string[] = [];
    const spans = new Map<string, { first: string; last: string }>();
    if (from <= today) {
      // A month at a time, oldest first.
      for (const m of monthRanges(from, today)) {
        const measured = await readMeasuredBalances(ctx, daysIn(m.from, m.to));
        unreadableDays.push(...measured.unreadable);
        for (const date of [...measured.balances.keys()].sort()) {
          // Each balance under the account it belongs to now; of two ids of
          // one account on one day, the one its history is read from first.
          const best = new Map<string, { rank: number; balance: number }>();
          for (const [recordedAs, balance] of Object.entries(measured.balances.get(date) ?? {})) {
            const placed = place(recordedAs);
            if (!placed || !listed.has(placed.account)) continue;
            // From its end on, an account that ended is in no day, nor in its span.
            const end = listed.get(placed.account)!.ended;
            if (end !== undefined && date >= end) continue;
            const prev = best.get(placed.account);
            if (!prev || placed.rank < prev.rank) best.set(placed.account, { rank: placed.rank, balance });
          }
          for (const id of best.keys()) {
            const s = spans.get(id);
            if (!s) spans.set(id, { first: date, last: date });
            else s.last = date;
          }
          series.add(date, new Map([...best].map(([id, b]) => [id, b.balance])));
        }
      }
    }

    const days = series.days;
    const anchorAt = days.findIndex(isComplete);
    const anchor: InvestedDay | null = anchorAt < 0 ? null : days[anchorAt];
    // The last complete day of each month, from the anchor on.
    const months: { date: string; total: number }[] = [];
    if (anchorAt >= 0) {
      for (const d of days.slice(anchorAt)) {
        if (!isComplete(d)) continue;
        const last = months[months.length - 1];
        if (last && last.date.slice(0, 7) === d.date.slice(0, 7)) months[months.length - 1] = { date: d.date, total: d.total as number };
        else months.push({ date: d.date, total: d.total as number });
      }
    }
    return NextResponse.json(
      {
        currency: saved.currency,
        saved_day: saved.day,
        anchor,
        latest: days.length > 0 ? days[days.length - 1] : null,
        months,
        accounts: [...listed.values()]
          .sort((a, b) => (a.account_id < b.account_id ? -1 : 1))
          .map((a) => ({ account_id: a.account_id, first: spans.get(a.account_id)?.first ?? null, last: spans.get(a.account_id)?.last ?? null, ended: a.ended ?? null, label: labels.get(a.account_id) ?? null })),
        unreadable_days: unreadableDays.sort(),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return storeFailure(err, 'Failed to read your invested assets over time');
  }
}

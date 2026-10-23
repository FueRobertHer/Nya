// lib/report/runway-read.ts
//
// What the runway (lib/report/runway.ts) is made of, read the way a report
// reads (lib/report/read.ts) and the read-only API lists accounts
// (lib/api-read.ts), never a third way, for the report page
// (app/api/reports/runway) and the API (/api/v1/runway, lib/api-reports.ts):
//
//   - the cash accounts, as /api/v1/accounts lists them (readAccounts: each
//     linked account at its newest measured balance, a manual one at the
//     balance typed, one SimpleFIN or Lunch Flow keeps up to date at the one
//     it last reported; hidden ones left out), and what couldn't be read of
//     them, named. An account that ended is no cash. The cash is the
//     forecast's (lib/forecast.ts cashPosition), less what is pending on it;
//   - the Activity tab's rows from MOVE_DAYS before the longest window's
//     first day on (so a payment or a move on that day finds its other side
//     posted before it), from one report read (readReportInput, without the
//     categories marked for taxes, which the runway never shows), as a report
//     counts them (periodRows: an ended account's from its end on left out),
//     with the rows before
//     them that recurring detection needs, so the spending is a report's
//     totals for the same months and the bills are the ones the dashboard
//     detects;
//   - each window's gaps, by the report's own rule (buildReport over its
//     days), so a month that may be short of transactions is the month a
//     report on those days would mark, and a window says only its own;
//   - the planned items and the series marked not recurring
//     (lib/planned-store.ts).
//
// WITH A HOME CURRENCY, what is in another currency converts into the
// runway's (lib/report/runway.ts WITH A HOME CURRENCY), with the rates the
// report read reads for the rows and the accounts' currencies (lib/fx/read.ts
// readFlowFx); a card's balance in another counts in what the cards owe,
// converted. `plain` adds the runway as before a home currency beside it, for
// the API's version 1 fields, from the same read.
//
// READ ONLY, and for display: nothing here writes, deletes or records
// anything on what it reads, and nothing is stored of what it works out. The
// planned items are read LENIENTLY for this display: ones that can't be read
// leave the runway without them, and it says so; storage that can't be
// reached, or the hidden accounts or account closures that can't be read,
// fail it, as they fail a report.

import type { Ctx } from '../containers';
import { readAccounts, type ApiAccount, type ApiMissing } from '../api-read';
import { plannedStore } from '../planned-store';
import { cashPosition, forecastConverter, MANUAL_STALE_DAYS, withWhy, type ForecastInstitution } from '../forecast';
import type { FxTable } from '../fx/rates';
import { isConnectorKind } from '../connectors/types';
import { isInvestmentType } from '../balance';
import { leftOutText } from '../spending';
import { tidy } from '../totals';
import { StoredDataUnreadableError } from '../repo';
import { readReportInput } from './read';
import { buildReport, periodRows, type Gap } from './build';
import { buildRunwayInputs, MOVE_DAYS, runwayWindow, RUNWAY_WINDOWS, type MonthShort, type RunwayBuilt, type RunwayWindow } from './runway';
import { addDays, dayIn, daysFrom, type Period } from './period';

/** A cash account the runway starts from, as of when its balance is. In
 *  another currency, converted with a home currency: `balance` in its own
 *  (`currency`), and what it counts as in the runway's (`converted`). */
export type RunwayCashAccount = {
  account_id: string;
  name: string;
  institution: string;
  balance: number;
  manual: boolean;
  as_of: string | null;
  currency?: string;
  converted?: number;
};

export type RunwayReport = RunwayBuilt & {
  version: 1;
  time_zone: string;
  generated_at: string;
  /** The included cash accounts, each with when its balance is from (a day,
   *  or an instant where it is known), oldest first. */
  cash_accounts: RunwayCashAccount[];
  /** What the cards (not hidden, not ended, in the runway's currency) owe
   *  now: their charges are in the spending, but paying them comes out of
   *  this cash. */
  owed_on_cards: number;
  /** A typed balance not updated for over a week (lib/forecast.ts MANUAL_STALE_DAYS). */
  stale_balances: { name: string; institution: string; updated_at: string }[];
  /** Each window's gaps, by the report's rule (lib/report/build.ts). */
  gaps: { months: RunwayWindow; gaps: Gap[] }[];
  /** When the window's transactions are from: the oldest last sync of the
   *  connections that bring them (a report's data_as_of). */
  data_as_of: string | null;
  /** What it can't see, in words with no amount and no date in them. */
  notes: string[];
  /** With a home currency and `plain` asked for: the runway as before one,
   *  nothing converted (the API's version 1 fields, lib/api-reports.ts). */
  plain?: RunwayReport;
};

/** A health savings account: money for health costs, never cash to live on. */
const isHsa = (a: Pick<ApiAccount, 'type' | 'subtype'>) => a.type === 'depository' && (a.subtype ?? '').toLowerCase() === 'hsa';

/** The cash accounts' institutions, as the forecast reads them, from the
 *  accounts the API lists: none that ended by today. */
function cashInstitutions(accounts: readonly ApiAccount[], today: string): ForecastInstitution[] {
  const out = new Map<string, ForecastInstitution>();
  for (const a of accounts) {
    if (a.hidden || (a.lifecycle && a.lifecycle.date <= today) || isHsa(a)) continue;
    const key = `${a.source}\n${a.institution}`;
    const inst = out.get(key) ?? {
      institution_name: a.institution,
      manual: a.source !== 'plaid',
      ...(isConnectorKind(a.source) ? { connector: a.source } : {}),
      accounts: [],
    };
    inst.accounts.push({
      account_id: a.id,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      balance: a.balance,
      currency: a.currency,
      ...(a.source === 'manual' && a.as_of_time ? { updated_at: a.as_of_time } : {}),
    });
    out.set(key, inst);
  }
  return [...out.values()];
}

/** What couldn't be read of the accounts, in words. */
function missingNotes(missing: readonly ApiMissing[]): string[] {
  const notes: string[] = [];
  const institutions = [...new Set(missing.filter((m) => m.institution !== null && m.account_id === null).map((m) => m.institution!))];
  for (const i of institutions) notes.push(`Your accounts at ${i} couldn’t be read, so any cash there isn’t in this.`);
  const accounts = missing.filter((m) => m.account_id !== null).length;
  if (accounts > 0) notes.push(`${accounts === 1 ? 'An account' : `${accounts} accounts`} couldn’t be read, so any cash in ${accounts === 1 ? 'it' : 'them'} isn’t in this.`);
  return notes;
}

export async function readRunway(ctx: Ctx, opts: { today: string; timeZone: string; now?: number; plain?: boolean }): Promise<RunwayReport> {
  const now = opts.now ?? Date.now();
  const { today, timeZone } = opts;
  const longest = runwayWindow(today, 12);
  const period: Period = { kind: 'range', start: addDays(longest.start, -MOVE_DAYS), end: today, through: today, today, time_zone: timeZone };
  const [{ input, history }, accounts, planned] = await Promise.all([
    readReportInput(ctx, period, { now, marked: false, fxAccounts: true }),
    readAccounts(ctx),
    // LENIENT, for this display only (see the header).
    plannedStore.get(ctx).then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => {
        if (err instanceof StoredDataUnreadableError) return { ok: false as const };
        throw err;
      }
    ),
  ]);
  // Each row on its account by the id the accounts are listed under: an older
  // id (an account reconnected, rows imported into a linked one) is followed
  // through the links to it, so rows and accounts are told apart by id, never
  // by a name two accounts may share.
  const rootOf = (id: string) => {
    let current = id;
    const seen = new Set([id]);
    for (let i = 0; i < 50; i++) {
      const next = input.links.get(current);
      if (!next || seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    return current;
  };
  const rows = periodRows(input, period).rows.map((t) => (t.account_id ? { ...t, account_id: rootOf(t.account_id) } : t));
  // Each window's gaps and the months they leave short, as a report on its
  // days says them (a month is marked alike in each window that holds it).
  const reports = RUNWAY_WINDOWS.map((months) => {
    const w = runwayWindow(today, months);
    return { months, report: buildReport({ ...input, period: { kind: 'range', start: w.start, end: w.end, through: w.end, today, time_zone: timeZone } }) };
  });
  const report = reports[reports.length - 1].report;
  const short: MonthShort[] = report.months.filter((m) => m.uncertain).map((m) => ({ month: m.month, institutions: m.gaps }));

  const live = accounts.accounts.filter((a) => !a.hidden && !(a.lifecycle && a.lifecycle.date <= today));
  const byId = new Map(live.map((a) => [a.id, a]));
  const base = {
    version: 1 as const,
    time_zone: timeZone,
    generated_at: new Date(now).toISOString(),
    gaps: reports.map(({ months, report: r }) => ({ months, gaps: r.gaps })),
    data_as_of: report.data_as_of,
  };

  /** The runway from what was read, converted with `fx` (a home currency:
   *  see lib/report/runway.ts WITH A HOME CURRENCY), or as before one. */
  const assemble = (fx: FxTable | null): RunwayReport => {
    const position = cashPosition(cashInstitutions(live, today), rows, { fx, today });
    const built = buildRunwayInputs({
      today,
      position,
      rows,
      history,
      planned: planned.ok ? (planned.value?.items ?? []) : null,
      dismissed: planned.ok ? (planned.value?.dismissed ?? []) : null,
      short,
      accounts: accounts.accounts.map((a) => a.id),
      fx,
      now,
    });
    const currency = built.currency;
    // In the runway's currency: as written, or converted at the newest rates
    // as the position converts (lib/forecast.ts), or null with no rate.
    const conv = forecastConverter(fx, currency, today);
    const inRunway = (amount: number, c: string | null) => (c === null || currency === null || c === currency ? amount : conv.to(amount, c, false));

    const cash_accounts = position.included
      .map((a) => {
        const api = byId.get(a.account_id);
        const converted = a.currency ? inRunway(a.balance, a.currency) : null;
        return {
          account_id: a.account_id,
          name: a.name,
          institution: a.institution,
          balance: a.balance,
          manual: a.manual,
          as_of: api?.as_of_time ?? api?.as_of ?? null,
          ...(a.currency && converted !== null ? { currency: a.currency, converted } : {}),
        };
      })
      .sort((a, b) => (a.as_of ?? '').localeCompare(b.as_of ?? '') || a.institution.localeCompare(b.institution) || a.name.localeCompare(b.name));
    // What the cards owe, in the runway's currency: with a home currency, a
    // card in another converted at the newest rates; one with no rate isn't
    // added.
    const owed = live
      .filter((a) => a.type === 'credit' && a.balance !== null && a.balance > 0)
      .reduce((n, a) => {
        const v = inRunway(a.balance!, a.currency);
        return v === null ? n : n + v;
      }, 0);
    const stale = position.included.flatMap((a) => {
      if (!a.manual || !a.updated_at) return [];
      const day = dayIn(a.updated_at, timeZone);
      return day === null || daysFrom(day, today) <= MANUAL_STALE_DAYS ? [] : [{ name: a.name, institution: a.institution, updated_at: a.updated_at }];
    });

    const notes: string[] = [...missingNotes(accounts.missing_accounts)];
    for (const n of position.noBalance) notes.push(`${n.name} at ${n.institution} has no balance to start from, so it isn’t in this.`);
    // With a home currency, why each left out has no rate.
    const cashLeft = withWhy(leftOutText(position.leftOut, currency, { noun: 'cash account', where: 'this runway', plural: false }), position.conversion);
    if (cashLeft) notes.push(cashLeft);
    const eventsLeft = withWhy(leftOutText(built.events_left_out, currency, { noun: 'expected payment', where: 'this runway', plural: false }), built.conversion?.expected);
    if (eventsLeft) notes.push(eventsLeft);
    // A manual cash account with no transactions in the longest window: what
    // is spent from it isn't known.
    for (const a of position.included) {
      if (a.manual && !rows.some((t) => t.account_id === a.account_id && t.date >= longest.start && t.date <= longest.end)) {
        notes.push(`${a.name} at ${a.institution} has no transactions in the last 12 months, so what you spend from it isn’t in your spending.`);
      }
    }
    if (!built.has_cash && position.noBalance.length === 0) notes.push('No checking, savings or cash on hand is in Nya, so there is no cash to start from.');
    for (const a of live.filter(isHsa)) notes.push(`${a.name} at ${a.institution} is a health savings account, for health costs, so it isn’t counted as cash.`);
    if (live.some((a) => isInvestmentType(a.type))) {
      notes.push('Cash inside investment accounts, such as a brokerage’s settlement or money market fund, isn’t counted: it is money waiting to be invested, days from being spent.');
    }
    if (!planned.ok) notes.push('Your planned items couldn’t be read, so they aren’t in this, and bills you marked not recurring may be.');
    if (input.hidden) notes.push('Hidden accounts are left out, their balances and their transactions.');

    return { ...built, ...base, cash_accounts, owed_on_cards: tidy(owed), stale_balances: stale, notes };
  };

  // With a home currency, converted; as before one beside it when asked
  // (`plain`, the API's version 1 fields). Nothing more is read.
  const fx = input.fx?.home ? input.fx : null;
  const runway = assemble(fx);
  return fx && opts.plain ? { ...runway, plain: assemble(null) } : runway;
}

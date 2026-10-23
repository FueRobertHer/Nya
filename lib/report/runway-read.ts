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
//   - the Activity tab's rows from the longest window's first day on, from
//     one report read (readReportInput), as a report counts them (periodRows:
//     an ended account's from its end on left out), with the rows before
//     them that recurring detection needs, so the spending is a report's
//     totals for the same months and the bills are the ones the dashboard
//     detects;
//   - the window's gaps, by the report's own rule (buildReport over the
//     longest window), so a month that may be short of transactions is the
//     month a report on those days would mark;
//   - the planned items and the series marked not recurring
//     (lib/planned-store.ts).
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
import { cashPosition, MANUAL_STALE_DAYS, type ForecastInstitution } from '../forecast';
import { isConnectorKind } from '../connectors/types';
import { isInvestmentType } from '../balance';
import { leftOutText } from '../spending';
import { tidy } from '../totals';
import { StoredDataUnreadableError } from '../repo';
import { readReportInput } from './read';
import { buildReport, periodRows, type Gap } from './build';
import { buildRunwayInputs, runwayWindow, type MonthShort, type RunwayBuilt } from './runway';
import { dayIn, daysFrom, type Period } from './period';

/** A cash account the runway starts from, as of when its balance is. */
export type RunwayCashAccount = { account_id: string; name: string; institution: string; balance: number; manual: boolean; as_of: string | null };

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
  /** The longest window's gaps, by the report's rule (lib/report/build.ts). */
  gaps: Gap[];
  /** When the window's transactions are from: the oldest last sync of the
   *  connections that bring them (a report's data_as_of). */
  data_as_of: string | null;
  /** What it can't see, in words with no amount and no date in them. */
  notes: string[];
};

/** The cash accounts' institutions, as the forecast reads them, from the
 *  accounts the API lists: none that ended by today. */
function cashInstitutions(accounts: readonly ApiAccount[], today: string): ForecastInstitution[] {
  const out = new Map<string, ForecastInstitution>();
  for (const a of accounts) {
    if (a.hidden || (a.lifecycle && a.lifecycle.date <= today)) continue;
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

export async function readRunway(ctx: Ctx, opts: { today: string; timeZone: string; now?: number }): Promise<RunwayReport> {
  const now = opts.now ?? Date.now();
  const { today, timeZone } = opts;
  const longest = runwayWindow(today, 12);
  const period: Period = { kind: 'range', start: longest.start, end: today, through: today, today, time_zone: timeZone };
  const [{ input, history }, accounts, planned] = await Promise.all([
    readReportInput(ctx, period, { now }),
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
  const { rows } = periodRows(input, period);
  // The window's months that may be short, as a report on its days marks them.
  const report = buildReport({ ...input, period: { kind: 'range', start: longest.start, end: longest.end, through: longest.end, today, time_zone: timeZone } });
  const short: MonthShort[] = report.months.filter((m) => m.uncertain).map((m) => ({ month: m.month, institutions: m.gaps }));

  const live = accounts.accounts.filter((a) => !a.hidden && !(a.lifecycle && a.lifecycle.date <= today));
  const position = cashPosition(cashInstitutions(live, today), rows);
  const built = buildRunwayInputs({
    today,
    position,
    rows,
    history,
    planned: planned.ok ? (planned.value?.items ?? []) : null,
    dismissed: planned.ok ? (planned.value?.dismissed ?? []) : null,
    short,
  });
  const currency = built.currency;
  const byId = new Map(live.map((a) => [a.id, a]));

  const cash_accounts = position.included
    .map((a) => {
      const api = byId.get(a.account_id);
      return { account_id: a.account_id, name: a.name, institution: a.institution, balance: a.balance, manual: a.manual, as_of: api?.as_of_time ?? api?.as_of ?? null };
    })
    .sort((a, b) => (a.as_of ?? '').localeCompare(b.as_of ?? '') || a.institution.localeCompare(b.institution) || a.name.localeCompare(b.name));
  const owed = live
    .filter((a) => a.type === 'credit' && a.balance !== null && a.balance > 0 && (a.currency === null || currency === null || a.currency === currency))
    .reduce((n, a) => n + a.balance!, 0);
  const stale = position.included.flatMap((a) => {
    if (!a.manual || !a.updated_at) return [];
    const day = dayIn(a.updated_at, timeZone);
    return day === null || daysFrom(day, today) <= MANUAL_STALE_DAYS ? [] : [{ name: a.name, institution: a.institution, updated_at: a.updated_at }];
  });

  const notes: string[] = [...missingNotes(accounts.missing_accounts)];
  for (const n of position.noBalance) notes.push(`${n.name} at ${n.institution} has no balance to start from, so it isn’t in this.`);
  const cashLeft = leftOutText(position.leftOut, currency, { noun: 'cash account', where: 'this runway', plural: false });
  if (cashLeft) notes.push(cashLeft);
  const eventsLeft = leftOutText(built.events_left_out, currency, { noun: 'expected payment', where: 'this runway', plural: false });
  if (eventsLeft) notes.push(eventsLeft);
  // A manual cash account with no transactions in the longest window: what
  // is spent from it isn't known.
  for (const a of position.included) {
    if (a.manual && !rows.some((t) => t.account_id === a.account_id && t.date >= longest.start && t.date <= longest.end)) {
      notes.push(`${a.name} at ${a.institution} has no transactions in these months, so what you spend from it isn’t in your spending.`);
    }
  }
  if (live.some((a) => isInvestmentType(a.type))) {
    notes.push('Cash inside investment accounts, such as a brokerage’s settlement or money market fund, isn’t counted: it is money waiting to be invested, days from being spent.');
  }
  if (!planned.ok) notes.push('Your planned items couldn’t be read, so they aren’t in this, and bills you marked not recurring may be.');
  if (input.hidden) notes.push('Hidden accounts are left out, their balances and their transactions.');

  return {
    ...built,
    version: 1,
    time_zone: timeZone,
    generated_at: new Date(now).toISOString(),
    cash_accounts,
    owed_on_cards: tidy(owed),
    stale_balances: stale,
    gaps: report.gaps,
    data_as_of: report.data_as_of,
    notes,
  };
}

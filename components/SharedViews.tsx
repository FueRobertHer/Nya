'use client';

// The other kinds someone shares (#45 step 3, lib/share-kinds.ts), as the one
// they're shared with sees them on a "Shared by" card, and as the sharer sees
// them in "What they see": their net worth, spending, holdings, budgets and
// goals, read-only, each with the day it is as of. What each holds was built
// on the server (lib/share-views.ts); this only draws it. Every amount is
// written by lib/format.ts as it is drawn, inside <Masked>, so hiding amounts
// hides it and a screen reader says "hidden"; a percentage stays, as it says
// no amount, in the words the server sent with it (`label`: never "0%" for
// money that is there, nor "100%" short of the whole). One column, each kind
// a section of the card.
//
// What qualifies a figure is said under it, at the level the owner's own
// screens give the same fact (design-system.md "Status and honesty"),
// gathered as Home's total gathers its caveats (components/TotalCaveats.tsx):
// a currency left out for want of a public rate is critical, as on Home
// (components/CurrencyNotes.tsx); totals not converted, accounts with no
// balance yet, a month that may be short, what holdings don't count and how
// they file that couldn't be read are cautions; what is converted, or left
// out by their own choice, is information.
//
// Class names avoid "share" (see components/Sharing.tsx).

import { useState } from 'react';
import { formatDay, formatMoney, onDay } from '@/lib/format';
import { readableName } from '@/lib/merchant-name';
import { monthLabel } from '@/lib/goal-text';
import {
  isUnreadable,
  KIND_NAME,
  VIEW_KINDS,
  type BudgetLine,
  type BudgetsView,
  type GoalLine,
  type GoalsView,
  type HoldingsLine,
  type HoldingsView,
  type NetWorthView,
  type SharedConversion,
  type SharedViews,
  type SpendingView,
  type ViewKind,
} from '@/lib/share-kinds';
import { Masked } from './HideAmounts';
import NetWorthChart from './NetWorthChart';
import { shortDate } from './SharingDates';
import TotalCaveats, { Notice, type Caveat } from './TotalCaveats';

/** A bar as long as a share (capped at the whole), in the meter's colors:
 *  warn (hatched amber) from near a budget's limit and past it, as the
 *  Budgets tab's own meters are since rollout 6a2, never red; done for a
 *  goal reached. A meter named for its line (`label`), its share in
 *  percent. */
function Bar({ pct, state = '', label }: { pct: number | null; state?: '' | ' warn' | ' done'; label: string }) {
  const width = pct === null ? 0 : Math.max(0, Math.min(pct, 100));
  return (
    <div
      className={`meter-track incoming-meter${state === ' done' ? '' : state}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === null ? undefined : Math.round(width)}
    >
      <div className={`meter-fill${state}`} style={{ width: `${width}%` }} />
    </div>
  );
}

const unreadableText: Record<ViewKind, string> = {
  net_worth: 'net worth',
  spending: 'spending',
  holdings: 'holdings',
  budgets: 'budgets',
  goals: 'goals',
};

/**
 * Each kind shared, in the order kinds are listed everywhere. `whose` is
 * whose they are, as the card says it: "Sam’s", or "Your" in the sharer's
 * own preview.
 */
export function SharedViewsList({ views, whose }: { views: SharedViews; whose: string }) {
  return (
    <>
      {VIEW_KINDS.map((kind) => {
        const v = views[kind];
        if (!v) return null;
        return (
          <section key={kind} className="incoming-kind" aria-label={KIND_NAME[kind]}>
            <p className="incoming-kind-name">{KIND_NAME[kind]}</p>
            {isUnreadable(v) ? (
              <Notice level="caution">{`${whose} ${unreadableText[kind]} couldn’t be read just now, so none of it is shown.`}</Notice>
            ) : kind === 'net_worth' ? (
              <NetWorthKind v={v as NetWorthView} />
            ) : kind === 'spending' ? (
              <SpendingKind v={v as SpendingView} />
            ) : kind === 'holdings' ? (
              <HoldingsKind v={v as HoldingsView} />
            ) : kind === 'budgets' ? (
              <BudgetsKind v={v as BudgetsView} />
            ) : (
              <GoalsKind v={v as GoalsView} />
            )}
          </section>
        );
      })}
    </>
  );
}

/** A figure converted into the owner's home currency (decision 5), in
 *  words: at the ECB's daily rates, which are public; a share never uses the
 *  owner's own (lib/share-views.ts). */
export function convertedWords(into: string | null, c: SharedConversion | undefined, lead = 'Converted into'): string | null {
  if (!c || !into) return null;
  return `${lead} ${into} at the European Central Bank’s daily rates.`;
}

/** That a figure is converted, as a caveat on it: information. */
function convertedCaveat(into: string | null, c: SharedConversion | undefined, lead?: string): Caveat[] {
  const words = convertedWords(into, c, lead);
  return words ? [{ key: 'converted', severity: 'info', summary: `converted into ${into}`, body: words }] : [];
}

// ---- Net worth ----

/** What the total leaves out, under it: an account in a currency with no
 *  public rate, critical, as Home says it (the total is short); in a
 *  currency their totals don't convert, a caution, as Home says mixed
 *  currencies; an account with no balance yet, a caution, as Home says a
 *  connection waiting for its first answer. */
function netWorthCaveats(v: NetWorthView): Caveat[] {
  const out: Caveat[] = [];
  for (const o of v.other_currencies)
    out.push({
      key: `other:${o.currency}`,
      severity: v.converted ? 'critical' : 'caution',
      summary: v.converted ? 'a currency left out' : 'currencies not converted',
      body: `${o.accounts === 1 ? '1 account' : `${o.accounts} accounts`} in ${o.currency} ${o.accounts === 1 ? 'isn’t' : 'aren’t'} in this total: ${
        v.converted ? 'there is no public rate for it' : 'their totals don’t convert currencies'
      }.`,
    });
  if (v.without_balance > 0)
    out.push({
      key: 'without-balance',
      severity: 'caution',
      summary: v.without_balance === 1 ? 'an account with no balance' : 'accounts with no balance',
      body: `${v.without_balance === 1 ? '1 account has' : `${v.without_balance} accounts have`} no balance yet, so ${v.without_balance === 1 ? 'it isn’t' : 'they aren’t'} in this total.`,
    });
  return [...out, ...convertedCaveat(v.currency, v.converted)];
}

function NetWorthKind({ v }: { v: NetWorthView }) {
  const history = v.history ?? [];
  return (
    <>
      <div className="peer-row">
        <span className="incoming-account-date">{v.as_of ? `As of ${shortDate(v.as_of)}${v.from && v.from !== v.as_of ? `, balances from ${shortDate(v.from)} on` : ''}` : ''}</span>
        <span className="incoming-account-value">{v.total === null ? 'No balance yet' : <Masked>{formatMoney(v.total, v.currency)}</Masked>}</span>
      </div>
      <TotalCaveats items={netWorthCaveats(v)} />
      {v.detail === 'history' &&
        (history.length >= 2 ? (
          <>
            <NetWorthChart points={history} label="Net worth" currency={v.currency} rangeSet="balance" />
            <p className="panel-note">
              One point a week. Dashed stretches are estimates, worked out from transactions rather than recorded.
              {v.history_mixed ? ' It adds accounts in other currencies as they are, unconverted, as their own chart does.' : ''}
            </p>
          </>
        ) : (
          <p className="panel-note">{history.length === 1 ? `Its history begins ${shortDate(history[0].date)}; a point is added each week.` : 'No history recorded yet.'}</p>
        ))}
      {v.accounts && (
        <p className="panel-note">Only the accounts whose balances are shared are listed.</p>
      )}
      {v.accounts && v.accounts.length > 0 && (
        <div className="incoming-kind-lines">
          {v.accounts.map((a, i) => (
            <div key={`${a.label}-${i}`} className="peer-row">
              <span>
                <span className="incoming-account-name">{a.label}</span>
                {a.as_of && <span className="incoming-account-date"> · {shortDate(a.as_of)}</span>}
              </span>
              <span className="incoming-account-value">
                <Masked>{`${formatMoney(a.balance, a.currency)}${a.debt ? ' owed' : ''}`}</Masked>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---- Spending ----

/** Some of how they file their transactions couldn't be read
 *  (lib/share-kinds.ts FilingUnread): said under spending and budgets alike,
 *  a caution in both. */
const FILING_UNREAD = 'Some of how they file their transactions couldn’t be read just now, so some of this may be under another category than the one they chose.';
const filingCaveat = (unread: boolean | undefined): Caveat[] =>
  unread ? [{ key: 'filing-unread', severity: 'caution', summary: 'categories that couldn’t be read', body: FILING_UNREAD }] : [];

/** What may make a month's spending off, under its total: the same for each
 *  month but whether its exclusions could all be read. That a month may be
 *  short is a caution, as the owner's Activity says what may be missing;
 *  what they left out, and what couldn't be read of it, information, as
 *  Activity says them in its note. */
function spendingCaveats(v: SpendingView, m: SpendingView['months'][number] | undefined): Caveat[] {
  return [
    ...(v.may_be_incomplete ? [{ key: 'may-be-short', severity: 'caution' as const, summary: 'a month may be short', body: 'Some transactions aren’t all in yet, so a month may be short.' }] : []),
    ...filingCaveat(v.filing_unread),
    ...(m?.left_out ? [{ key: 'left-out', severity: 'info' as const, summary: 'other currencies left out', body: m.left_out }] : []),
    ...(m?.exclusions_unknown || v.exclusions_unread
      ? [{ key: 'exclusions', severity: 'info' as const, summary: 'exclusions that couldn’t be read', body: 'Whether they left some transactions out of their totals couldn’t be read, so those are counted here.' }]
      : []),
    ...convertedCaveat(v.currency, v.converted),
  ];
}

function SpendingKind({ v }: { v: SpendingView }) {
  const [at, setAt] = useState(0);
  if (v.months.length === 0) {
    return (
      <>
        <p className="empty-note">No spending recorded yet.</p>
        <TotalCaveats items={spendingCaveats(v, undefined)} />
      </>
    );
  }
  const m = v.months[Math.min(at, v.months.length - 1)];
  const amounts = v.detail === 'amounts';
  const name = (month: string, soFar: boolean) => `${monthLabel(month)}${soFar ? ', so far' : ''}`;
  return (
    <>
      <div className="peer-row">
        <select value={at} onChange={(e) => setAt(Number(e.target.value))} aria-label="Month">
          {v.months.map((x, i) => (
            <option key={x.month} value={i}>
              {name(x.month, x.so_far)}
            </option>
          ))}
        </select>
        {amounts && m.total !== undefined && (
          <span className="incoming-account-value">
            <Masked>{formatMoney(m.total, v.currency)}</Masked>
          </span>
        )}
      </div>
      <TotalCaveats items={spendingCaveats(v, m)} />
      {m.groups.length === 0 ? (
        <p className="empty-note">Nothing spent in {name(m.month, m.so_far)}.</p>
      ) : (
        <div className="incoming-kind-lines">
          {m.groups.map((g, i) => (
            <div key={`${g.name}-${i}`} className="incoming-line">
              <div className="peer-row">
                <span className="incoming-account-name">{g.name}</span>
                <span className="incoming-account-value">{amounts && g.amount !== undefined ? <Masked>{`${formatMoney(g.amount, v.currency)} · ${g.label ?? ''}`}</Masked> : g.label}</span>
              </div>
              <Bar pct={g.pct} label={g.name} />
              {g.categories?.map((c, j) => (
                <div key={`${c.name}-${j}`} className="peer-row incoming-sub">
                  <span>{c.name}</span>
                  <span className="incoming-account-value">{amounts && c.amount !== undefined ? <Masked>{`${formatMoney(c.amount, v.currency)} · ${c.label ?? ''}`}</Masked> : c.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <p className="panel-note">
        {amounts ? 'What went out, by their own categories' : 'Each part’s share of what went out, by their own categories'}: never transfers, cash taken out, loan
        payments, or what they left out of their totals, and never the transactions themselves.
      </p>
    </>
  );
}

// ---- Holdings ----

function HoldingsTable({ title, lines, currency, amounts }: { title: string; lines: HoldingsLine[]; currency: string | null; amounts: boolean }) {
  return (
    <div className="incoming-kind-lines">
      <p className="incoming-kind-sub">{title}</p>
      {lines.map((l) => (
        <div key={l.slot} className="incoming-line">
          <div className="peer-row">
            <span className="incoming-account-name">{l.name}</span>
            <span className="incoming-account-value">
              {amounts && l.amount !== undefined ? <Masked>{`${formatMoney(l.amount, currency)} · ${l.label ?? ''}`}</Masked> : l.label}
            </span>
          </div>
          <Bar pct={l.pct} label={l.name} />
        </div>
      ))}
    </div>
  );
}

/** Holdings' notes that are information, as the owner's allocation says
 *  them: what Unclassified is, and that there is nothing to show. Every
 *  other note (lib/share-views.ts) says what the figures don't count (a
 *  currency with no rate, a position with no value, an account with no
 *  balance), a caution, as the owner's FI progress and allocation say them.
 *  The server sends them as words alone, so a note not known here is taken
 *  as a caution: a new one is never drawn lower than it may be. */
const HOLDINGS_INFO = [/^Unclassified is money /, /^No investment accounts to show\./];
const holdingsInfo = (n: string) => HOLDINGS_INFO.some((r) => r.test(n));
const holdingsSummary = (n: string) =>
  /^What is held in /.test(n) ? 'other currencies left out' : /with no value/.test(n) ? 'positions with no value' : /no balance yet/.test(n) ? 'accounts with no balance' : 'something not counted';

/** What the figures don't count, under them, and that they are converted. */
function holdingsCaveats(v: HoldingsView): Caveat[] {
  return [
    ...v.notes.filter((n) => !holdingsInfo(n)).map((n) => ({ key: `note:${n}`, severity: 'caution' as const, summary: holdingsSummary(n), body: n })),
    ...convertedCaveat(v.currency, v.converted),
  ];
}

function HoldingsKind({ v }: { v: HoldingsView }) {
  const amounts = v.detail === 'amounts';
  return (
    <>
      <div className="peer-row">
        <span className="incoming-account-date">
          {v.as_of ? `As of ${shortDate(v.as_of)}${v.from && v.from !== v.as_of ? `, positions and balances from ${shortDate(v.from)} on` : ''}` : 'Nothing recorded yet'}
        </span>
        {amounts && v.total !== undefined && (
          <span className="incoming-account-value">
            <Masked>{formatMoney(v.total, v.currency)}</Masked>
          </span>
        )}
      </div>
      <TotalCaveats items={holdingsCaveats(v)} />
      {v.classes.length > 0 && <HoldingsTable title="By asset class" lines={v.classes} currency={v.currency} amounts={amounts} />}
      {v.buckets.length > 0 && <HoldingsTable title="By tax bucket" lines={v.buckets} currency={v.currency} amounts={amounts} />}
      {v.positions && v.positions.length > 0 && (
        <div className="incoming-kind-lines">
          <p className="incoming-kind-sub">Positions</p>
          {v.positions.map((p, i) => (
            <div key={`${p.ticker ?? p.name ?? ''}-${i}`} className="peer-row">
              <span>
                <span className="incoming-account-name">{p.ticker ?? (p.name ? readableName(p.name) : 'A holding')}</span>
                <span className="incoming-account-date"> · {p.ticker && p.name ? `${readableName(p.name)}, ` : ''}{p.class}</span>
              </span>
              <span className="incoming-account-value">{amounts && p.amount !== undefined ? <Masked>{formatMoney(p.amount, v.currency)}</Masked> : p.label}</span>
            </div>
          ))}
        </div>
      )}
      {v.notes.filter(holdingsInfo).map((n) => (
        <p key={n} className="panel-note">
          {n}
        </p>
      ))}
    </>
  );
}

// ---- Budgets ----

/** Spent against what is available, in words: "$80.00 of $300.00", or a
 *  percentage; nothing available is said, never a limit of zero. Over is
 *  said by its badge (BudgetRow). */
function budgetText(b: BudgetLine, currency: string | null): string {
  if (b.spent !== undefined && b.limit !== undefined) {
    if (b.limit <= 0) return `${formatMoney(b.spent, currency)} spent, nothing left`;
    return `${formatMoney(b.spent, currency)} of ${formatMoney(b.limit, currency)}`;
  }
  if (b.label === null) return 'Nothing left';
  return `${b.label} spent`;
}

/** Amber from 85% of what is available, and past it, as the Budgets tab's
 *  meters (components/BudgetsCard.tsx): a budget over is a caution, never
 *  red, and its Over badge says it in a word. */
const meterOf = (b: BudgetLine): '' | ' warn' => (b.over || (b.pct !== null && b.pct >= 85) ? ' warn' : '');

function BudgetRow({ b, currency, sub = false }: { b: BudgetLine; currency: string | null; sub?: boolean }) {
  return (
    <div className={`incoming-line${sub ? ' incoming-sub' : ''}`}>
      <div className="peer-row">
        <span className={sub ? undefined : 'incoming-account-name'}>
          {b.name}
          {/* Over in a word beside its name, as the Budgets tab says it: not
              by the meter's color alone, and never masked, as it says no
              amount. */}
          {b.over && (
            <>
              {' '}
              <span className="badge warn">Over</span>
            </>
          )}
        </span>
        <span className="incoming-account-value">
          <Masked>{budgetText(b, currency)}</Masked>
        </span>
      </div>
      <Bar pct={b.pct ?? (b.over ? 100 : 0)} state={meterOf(b)} label={b.name} />
    </div>
  );
}

/** What may make a month's budgets off, under its total: a caution, as the
 *  owner's Budgets says a month that may be missing transactions; what they
 *  left out, information. */
function budgetMonthCaveats(m: BudgetsView['months'][number]): Caveat[] {
  return [
    ...(m.may_be_incomplete
      ? [
          {
            key: 'may-be-off',
            severity: 'caution' as const,
            summary: 'a month may be off',
            body: `What is spent in ${monthLabel(m.month)} may be off: some of its transactions may not all be in, or couldn’t all be read.`,
          },
        ]
      : []),
    ...(m.left_out ? [{ key: 'left-out', severity: 'info' as const, summary: 'other currencies left out', body: m.left_out }] : []),
  ];
}

function BudgetsKind({ v }: { v: BudgetsView }) {
  return (
    <>
      {/* What bears on both months, said once, above them: how they file
          that couldn't be read, and that spending is converted. */}
      <TotalCaveats items={[...filingCaveat(v.filing_unread), ...convertedCaveat(v.currency, v.converted, 'Spending in other currencies counts converted into')]} />
      {v.months.map((m, i) => (
        <div key={m.month} className="incoming-kind-lines">
          <p className="incoming-kind-sub">{`${i === 0 ? 'This month' : 'Last month'}, ${monthLabel(m.month)}`}</p>
          {m.groups.length === 0 ? (
            <>
              <p className="empty-note">No budgets.</p>
              <TotalCaveats items={budgetMonthCaveats(m)} />
            </>
          ) : (
            <>
              <BudgetRow b={m.total} currency={v.currency} />
              <TotalCaveats items={budgetMonthCaveats(m)} />
              {m.groups.map((g, i) => (
                <div key={`${g.name}-${i}`}>
                  <BudgetRow b={g} currency={v.currency} />
                  {g.categories?.map((c, j) => (
                    <BudgetRow key={`${c.name}-${j}`} b={c} currency={v.currency} sub />
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      ))}
      <p className="panel-note">Spent against what is available, with what rolled over, by their own budgets.</p>
    </>
  );
}

// ---- Goals ----

/** When a goal will be reached, in words, never with the rate behind it. */
export function outlookWords(g: GoalLine): string | null {
  const o = g.outlook;
  if (!o) return null;
  const due = g.target_date ? monthLabel(g.target_date.slice(0, 7)) : null;
  switch (o.status) {
    case 'complete':
      return 'Reached';
    case 'no_recent_contributions':
      return 'Nothing has gone into it lately';
    case 'no_rate':
      return 'When it will be reached isn’t known yet';
    case 'on_track':
    case 'behind': {
      if (o.beyond || !o.completion) return 'Not within 50 years at this pace';
      const when = monthLabel(o.completion);
      if (o.date_passed && g.target_date) return `Its date, ${formatDay(g.target_date, { sentence: true })}, has passed; at this pace, reached in ${when}`;
      if (o.status === 'on_track') return due && o.completion < g.target_date!.slice(0, 7) ? `On track for ${when}, ahead of ${due}` : `On track for ${due ?? when}`;
      return `Behind${due ? ` its date, ${due}` : ''}: at this pace, reached in ${when}`;
    }
  }
}

/** Why a goal shows no progress, for every state but tracked. */
function goalState(g: GoalLine): string | null {
  switch (g.state) {
    case 'untracked':
      return 'Not tracked against an account';
    case 'ended':
      return g.ended_on ? `Its account ended ${onDay(formatDay(g.ended_on, { sentence: true }))}, so it counts nothing from then` : 'Its account ended, so it counts nothing';
    case 'owed':
      return 'Tracks a card or a loan, whose balance is owed, so no progress is shown';
    case 'no_balance':
      return 'No balance is known for its account yet';
    case 'disconnected':
      return 'Its account is no longer connected';
    case 'unavailable':
      return 'Its account couldn’t be read just now';
    case 'tracked':
      return null;
  }
}

function GoalsKind({ v }: { v: GoalsView }) {
  if (v.goals.length === 0) return <p className="empty-note">No goals to show.</p>;
  return (
    <div className="incoming-kind-lines">
      {v.goals.map((g, i) => {
        const why = goalState(g);
        const outlook = outlookWords(g);
        const amounts = g.saved !== undefined && g.target !== undefined;
        return (
          <div key={`${g.name}-${i}`} className="incoming-line">
            <div className="peer-row">
              <span className="incoming-account-name">{g.name}</span>
              <span className="incoming-account-value">
                {amounts ? <Masked>{`${formatMoney(g.saved!, g.currency)} of ${formatMoney(g.target!, g.currency)}`}</Masked> : g.target !== undefined ? <Masked>{`Target ${formatMoney(g.target, g.currency)}`}</Masked> : g.label}
              </span>
            </div>
            {g.pct !== null && <Bar pct={g.pct} state={g.pct >= 100 ? ' done' : ''} label={g.name} />}
            <div className="incoming-account-date">
              {[why, outlook, g.label !== null && amounts ? `${g.label} of the way` : null, g.target_date && !outlook ? `Its date: ${formatDay(g.target_date, { sentence: true })}` : null, g.as_of ? `as of ${shortDate(g.as_of)}` : null]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        );
      })}
    </div>
  );
}

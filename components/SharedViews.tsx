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
// an account left out of net worth for want of a public rate is critical,
// as on Home (components/CurrencyNotes.tsx); totals not converted, accounts
// with no balance yet, a month that may be short, what holdings don't count
// and how they file that couldn't be read are cautions; what is converted,
// what spending and budgets leave out in other currencies (as the owner's
// Activity and Budgets say it), and whether exclusions could be read, are
// information.
//
// Class names avoid "share" (see components/Sharing.tsx).

import { useId, useState, type ReactNode } from 'react';
import { formatDay, formatMoney, onDay } from '@/lib/format';
import { readableName } from '@/lib/merchant-name';
import { monthLabel } from '@/lib/goal-text';
import {
  isUnreadable,
  KIND_NAME,
  VIEW_KINDS,
  type BudgetGroup,
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
 *  percent. Spans, as it sits in a row's text. */
function Bar({ pct, state = '', label }: { pct: number | null; state?: '' | ' warn' | ' done'; label: string }) {
  const width = pct === null ? 0 : Math.max(0, Math.min(pct, 100));
  return (
    <span
      className={`meter-track incoming-meter${state === ' done' ? '' : state}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct === null ? undefined : Math.round(width)}
    >
      <span className={`meter-fill${state}`} style={{ width: `${width}%` }} />
    </span>
  );
}

/** One line of a kind, a row in its list (`.list-row`, read-only): its name,
 *  what is under it (a meter, a meta line), and its figure. */
function Line({ title, value, children, sub }: { title: ReactNode; value: ReactNode; children?: ReactNode; sub?: ReactNode }) {
  return (
    <li>
      <div className="list-row">
        <span className="list-row-text">
          <span className="list-row-title">{title}</span>
          {children}
          {sub && <span className="list-row-sub">{sub}</span>}
        </span>
        <span className="list-row-value money">{value}</span>
      </div>
    </li>
  );
}

/** A kind's figure, on the line under its name: what it is as of (or the
 *  month it is for) on the left, the figure on the right. */
function Figure({ lead, value }: { lead: ReactNode; value: ReactNode }) {
  return (
    <div className="incoming-figure">
      {lead}
      {value !== null && <span className="incoming-figure-value money">{value}</span>}
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
 * Each kind shared, in the order kinds are listed everywhere, each under its
 * name as a heading (the card's own is an <h2>; the parts inside a kind are
 * <h4>s). `whose` is whose they are, as the card says it: "Sam’s", or
 * "Your" in the sharer's own preview.
 */
export function SharedViewsList({ views, whose }: { views: SharedViews; whose: string }) {
  return (
    <>
      {VIEW_KINDS.map((kind) => {
        const v = views[kind];
        if (!v) return null;
        return (
          <div key={kind} className="incoming-kind stack tight">
            <h3 className="incoming-kind-name">{KIND_NAME[kind]}</h3>
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
          </div>
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
      <Figure
        lead={<span className="helper">{v.as_of ? `As of ${shortDate(v.as_of)}${v.from && v.from !== v.as_of ? `, balances from ${shortDate(v.from)} on` : ''}` : ''}</span>}
        value={v.total === null ? 'No balance yet' : <Masked>{formatMoney(v.total, v.currency)}</Masked>}
      />
      <TotalCaveats items={netWorthCaveats(v)} />
      {v.detail === 'history' &&
        (history.length >= 2 ? (
          <>
            <NetWorthChart points={history} label="Net worth" currency={v.currency} rangeSet="balance" />
            <p className="helper">
              One point a week. Dashed stretches are estimates, worked out from transactions rather than recorded.
              {v.history_mixed ? ' It adds accounts in other currencies as they are, unconverted, as their own chart does.' : ''}
            </p>
          </>
        ) : (
          <p className="helper">{history.length === 1 ? `Its history begins ${shortDate(history[0].date)}; a point is added each week.` : 'No history recorded yet.'}</p>
        ))}
      {v.accounts && <p className="helper">Only the accounts whose balances are shared are listed.</p>}
      {v.accounts && v.accounts.length > 0 && (
        <ul className="list-rows">
          {v.accounts.map((a, i) => (
            <Line key={`${a.label}-${i}`} title={a.label} sub={a.as_of && shortDate(a.as_of, undefined, true)} value={<Masked>{`${formatMoney(a.balance, a.currency)}${a.debt ? ' owed' : ''}`}</Masked>} />
          ))}
        </ul>
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
 *  what is left out in other currencies, and whether exclusions could be
 *  read, information, as Activity says them in its note. With no month
 *  (`m` undefined) there is no figure to be converted, so that isn't said. */
function spendingCaveats(v: SpendingView, m: SpendingView['months'][number] | undefined): Caveat[] {
  return [
    ...(v.may_be_incomplete ? [{ key: 'may-be-short', severity: 'caution' as const, summary: 'a month may be short', body: 'Some transactions aren’t all in yet, so a month may be short.' }] : []),
    ...filingCaveat(v.filing_unread),
    ...(m?.left_out ? [{ key: 'left-out', severity: 'info' as const, summary: 'other currencies left out', body: m.left_out }] : []),
    ...(m?.exclusions_unknown || v.exclusions_unread
      ? [{ key: 'exclusions', severity: 'info' as const, summary: 'exclusions that couldn’t be read', body: 'Whether they left some transactions out of their totals couldn’t be read, so those are counted here.' }]
      : []),
    ...(m ? convertedCaveat(v.currency, v.converted) : []),
  ];
}

/** A share of spending, in words: the amount and its share at "amounts",
 *  else the share alone. */
function spentText(l: { amount?: number; label: string | null }, currency: string | null, amounts: boolean): ReactNode {
  return amounts && l.amount !== undefined ? <Masked>{`${formatMoney(l.amount, currency)} · ${l.label ?? ''}`}</Masked> : l.label;
}

function SpendingKind({ v }: { v: SpendingView }) {
  const [at, setAt] = useState(0);
  const monthId = useId();
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
      <Figure
        lead={
          <div className="field">
            <label htmlFor={monthId}>Month</label>
            <select id={monthId} value={at} onChange={(e) => setAt(Number(e.target.value))}>
              {v.months.map((x, i) => (
                <option key={x.month} value={i}>
                  {name(x.month, x.so_far)}
                </option>
              ))}
            </select>
          </div>
        }
        value={amounts && m.total !== undefined ? <Masked>{formatMoney(m.total, v.currency)}</Masked> : null}
      />
      <TotalCaveats items={spendingCaveats(v, m)} />
      {m.groups.length === 0 ? (
        <p className="empty-note">Nothing spent in {name(m.month, m.so_far)}.</p>
      ) : (
        <ul className="list-rows">
          {m.groups.map((g, i) => (
            <li key={`${g.name}-${i}`}>
              <div className="list-row">
                <span className="list-row-text">
                  <span className="list-row-title">{g.name}</span>
                  <Bar pct={g.pct} label={g.name} />
                </span>
                <span className="list-row-value money">{spentText(g, v.currency, amounts)}</span>
              </div>
              {g.categories && g.categories.length > 0 && (
                <ul className="list-rows incoming-sub-rows">
                  {g.categories.map((c, j) => (
                    <Line key={`${c.name}-${j}`} title={c.name} value={spentText(c, v.currency, amounts)} />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="helper">
        {amounts ? 'What went out, by their own categories' : 'Each part’s share of what went out, by their own categories'}: never transfers, cash taken out, loan
        payments, or what they left out of their totals, and never the transactions themselves.
      </p>
    </>
  );
}

// ---- Holdings ----

function HoldingsTable({ title, lines, currency, amounts }: { title: string; lines: HoldingsLine[]; currency: string | null; amounts: boolean }) {
  return (
    <>
      <h4 className="incoming-kind-sub">{title}</h4>
      <ul className="list-rows">
        {lines.map((l) => (
          <Line key={l.slot} title={l.name} value={spentText(l, currency, amounts)}>
            <Bar pct={l.pct} label={l.name} />
          </Line>
        ))}
      </ul>
    </>
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
  /^What is held in /.test(n)
    ? 'other currencies left out'
    : /with no value/.test(n)
      ? /^A position /.test(n)
        ? 'a position with no value'
        : 'positions with no value'
      : /no balance yet/.test(n)
        ? /^1 /.test(n)
          ? 'an account with no balance'
          : 'accounts with no balance'
        : 'something not counted';

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
      <Figure
        lead={
          <span className="helper">
            {v.as_of ? `As of ${shortDate(v.as_of)}${v.from && v.from !== v.as_of ? `, positions and balances from ${shortDate(v.from)} on` : ''}` : 'Nothing recorded yet'}
          </span>
        }
        value={amounts && v.total !== undefined ? <Masked>{formatMoney(v.total, v.currency)}</Masked> : null}
      />
      <TotalCaveats items={holdingsCaveats(v)} />
      {v.classes.length > 0 && <HoldingsTable title="By asset class" lines={v.classes} currency={v.currency} amounts={amounts} />}
      {v.buckets.length > 0 && <HoldingsTable title="By tax bucket" lines={v.buckets} currency={v.currency} amounts={amounts} />}
      {v.positions && v.positions.length > 0 && (
        <>
          <h4 className="incoming-kind-sub">Positions</h4>
          <ul className="list-rows">
            {v.positions.map((p, i) => (
              <Line
                key={`${p.ticker ?? p.name ?? ''}-${i}`}
                title={p.ticker ?? (p.name ? readableName(p.name) : 'A holding')}
                sub={`${p.ticker && p.name ? `${readableName(p.name)}, ` : ''}${p.class}`}
                value={amounts && p.amount !== undefined ? <Masked>{formatMoney(p.amount, v.currency)}</Masked> : p.label}
              />
            ))}
          </ul>
        </>
      )}
      {v.notes.filter(holdingsInfo).map((n) => (
        <p key={n} className="helper">
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

/** A budget's name with Over in a word beside it, as the Budgets tab says
 *  it: not by the meter's color alone, and never masked, as it says no
 *  amount. */
function budgetName(b: BudgetLine): ReactNode {
  return (
    <>
      {b.name}
      {b.over && (
        <>
          {' '}
          <span className="badge warn">Over</span>
        </>
      )}
    </>
  );
}

const budgetBar = (b: BudgetLine) => <Bar pct={b.pct ?? (b.over ? 100 : 0)} state={meterOf(b)} label={b.name} />;

/** A budget, a row in its month's list, and its categories, set in under it. */
function BudgetRow({ b, currency }: { b: BudgetGroup; currency: string | null }) {
  return (
    <li>
      <div className="list-row">
        <span className="list-row-text">
          <span className="list-row-title">{budgetName(b)}</span>
          {budgetBar(b)}
        </span>
        <span className="list-row-value money">
          <Masked>{budgetText(b, currency)}</Masked>
        </span>
      </div>
      {b.categories && b.categories.length > 0 && (
        <ul className="list-rows incoming-sub-rows">
          {b.categories.map((c, j) => (
            <Line key={`${c.name}-${j}`} title={budgetName(c)} value={<Masked>{budgetText(c, currency)}</Masked>}>
              {budgetBar(c)}
            </Line>
          ))}
        </ul>
      )}
    </li>
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
        <div key={m.month} className="stack tight">
          <h4 className="incoming-kind-sub">{`${i === 0 ? 'This month' : 'Last month'}, ${monthLabel(m.month)}`}</h4>
          {m.groups.length === 0 ? (
            <>
              <p className="empty-note">No budgets.</p>
              <TotalCaveats items={budgetMonthCaveats(m)} />
            </>
          ) : (
            <>
              {/* The month's total as its figure, its meter under it. */}
              <div>
                <Figure lead={<span className="incoming-figure-name">{budgetName(m.total)}</span>} value={<Masked>{budgetText(m.total, v.currency)}</Masked>} />
                {budgetBar(m.total)}
              </div>
              <TotalCaveats items={budgetMonthCaveats(m)} />
              <ul className="list-rows">
                {m.groups.map((g, j) => (
                  <BudgetRow key={`${g.name}-${j}`} b={g} currency={v.currency} />
                ))}
              </ul>
            </>
          )}
        </div>
      ))}
      <p className="helper">Spent against what is available, with what rolled over, by their own budgets.</p>
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
    <ul className="list-rows">
      {v.goals.map((g, i) => {
        const why = goalState(g);
        const outlook = outlookWords(g);
        const amounts = g.saved !== undefined && g.target !== undefined;
        return (
          <Line
            key={`${g.name}-${i}`}
            title={g.name}
            value={amounts ? <Masked>{`${formatMoney(g.saved!, g.currency)} of ${formatMoney(g.target!, g.currency)}`}</Masked> : g.target !== undefined ? <Masked>{`Target ${formatMoney(g.target, g.currency)}`}</Masked> : g.label}
            sub={[why, outlook, g.label !== null && amounts ? `${g.label} of the way` : null, g.target_date && !outlook ? `Its date: ${formatDay(g.target_date, { sentence: true })}` : null, g.as_of ? `as of ${shortDate(g.as_of)}` : null]
              .filter(Boolean)
              .join(' · ')}
          >
            {g.pct !== null && <Bar pct={g.pct} state={g.pct >= 100 ? ' done' : ''} label={g.name} />}
          </Line>
        );
      })}
    </ul>
  );
}

'use client';

// Accounts > Investments (docs/design/information-architecture.md #accounts):
// what the linked investment accounts did, from their own recorded balances
// and activity, in a brokerage's terms. A chip chooses the accounts (all,
// retirement or not, or one); under it the hero gives their investment
// returns over the range, their rate of return and the chart, whose range
// switch is the screen's; then the range's card: Beginning balance, Deposits
// & withdrawals, Investment returns and Ending balance, and a row for each
// account, which opens its sheet. Each currency is added up on its own,
// never converted: the hero is the home currency's, and each other one has
// its own card. The numbers are lib/growth-summary.ts's.
//
// All is all time once every chosen account has deposits and withdrawals
// Nya can carry, or months from its brokerage that start when it opened:
// from $0.00, when each opened, with a rate only where every account's
// months say when its money went in. Until then, All counts from the first
// recorded day, and the card says what to set.
//
// It loads every account's balance history in one read (app/api/
// account-history `ids`), and each account's activity through the cache its
// sheet uses (components/InvestmentActivity.tsx), one account per connection
// first: the activity route syncs the connection's whole store, and a second
// request while the first holds it would only be told it is still loading. A
// save of money in and out loads that account again; Refresh loads them all.
//
// What it can't count is said, never left out quietly: an account whose
// activity couldn't be loaded or is still loading in a critical notice by the
// figures it is missing from; manual and SimpleFIN or Lunch Flow accounts,
// which have no investment activity, in an information notice.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { nameAndMask, withMask } from '@/lib/account-names';
import { accountBucket, type TaxBucket } from '@/lib/allocation/buckets';
import { overridesOf } from '@/lib/allocation/settings';
import { currencyPlural, formatDay, formatMoney, MINUS, roundsToNothing, signedMoney } from '@/lib/format';
import { isInvestmentType } from '@/lib/balance';
import { RANGE_TEXT, type RangeKey } from '@/lib/chart-range';
import { connectorLabel } from '@/lib/connectors/types';
import { summarizeGrowth, type ActivityState, type CurrencyGroup, type Figures, type GrowthAccount, type GrowthRow } from '@/lib/growth-summary';
import { joinNames } from '@/lib/month-coverage';
import type { BalancePoint } from '@/lib/growth';
import { monthText, previousMonth, withPastMonths, type PastMonthsResult } from '@/lib/investment-months';
import type { Rate } from '@/lib/returns-rate';
import AccountsChooser, { presetOf, type ChooserPreset } from './AccountsChooser';
import type { Institution } from './accounts-format';
import { Hero } from './Hero';
import { useAmountsHidden } from './hide-amounts';
import { HeroScrub, type HeroReading } from './hero-scrub';
import { Masked } from './HideAmounts';
import { CHEVRON } from './InstitutionCard';
import { loadInvestmentActivity, onMoneyInOutSaved } from './InvestmentActivity';
import type { MoneyInOutTarget } from './MoneyInOutFigures';
import NetWorthChart from './NetWorthChart';
import { HeroFigure } from './NetWorthCard';
import { useSettingsRead } from './plan-detailed-home';
import { Segmented } from './Segmented';
import { focusInsteadOf } from './Sheet';
import { Notice } from './TotalCaveats';
import { Why } from './Why';
import { Strip, StripSkeleton } from './FiguresStrip';

/** An account on the screen, with what its row and sentences name it by. */
type Shown = GrowthAccount & {
  key: string;
  name: string;
  mask: string | null;
  /** "Roth IRA ••3302" */
  title: string;
  institution: string;
  retirement: boolean;
  /** Its activity as loaded, before the months: the totals form's. */
  raw: ActivityState;
  /** Its imported months joined to its history and activity
   *  (lib/investment-months.ts withPastMonths), or null without both. */
  past: PastMonthsResult | null;
};

/** The most ids one history read takes (app/api/account-history MAX_IDS). */
const IDS_PER_READ = 50;

const LOADING: ActivityState = { state: 'loading' };

const day = (iso: string) => formatDay(iso, { sentence: true });

const its = (n: number) => (n === 1 ? 'its' : 'their');

/** A retirement account: tax-deferred or Roth, by the person's choice or its
 *  subtype, or one Plaid calls a retirement account without saying which
 *  (lib/allocation/buckets.ts). */
function isRetirement(subtype: string | null, chosen: TaxBucket | undefined): boolean {
  const b = accountBucket(subtype, chosen);
  if (b.bucket === 'tax-deferred' || b.bucket === 'roth') return true;
  if (b.bucket !== 'unclassified') return false;
  const s = (subtype ?? '').trim().toLowerCase();
  return s === 'retirement' || s === 'non-taxable brokerage account';
}

/** "+9.2%", "−1.4%", "0.0%" */
function ratePct(r: Rate): string {
  const text = `${Math.abs(r.value * 100).toFixed(1)}%`;
  if (text === '0.0%') return text;
  return `${r.value > 0 ? '+' : MINUS}${text}`;
}

export default function InvestmentGrowth({
  institutions,
  main,
  refreshKey,
  onOpenAccount,
  onMoneyInOut,
}: {
  /** The institutions on the tab, without hidden or ended accounts. */
  institutions: readonly Institution[];
  /** The home currency, whose figures come first. */
  main: string | null;
  /** Changes on Refresh: everything loads again. */
  refreshKey: string | null;
  onOpenAccount: (item_id: string, account_id: string) => void;
  onMoneyInOut: (target: MoneyInOutTarget) => void;
}) {
  // Linked through Plaid: the only accounts Nya has investment activity for.
  const linked = useMemo(
    () =>
      institutions
        .filter((inst) => !inst.manual)
        .flatMap((inst) =>
          inst.accounts
            .filter((a) => isInvestmentType(a.type))
            .map((a) => ({ inst, a, key: `${inst.item_id}:${a.account_id}` }))
        ),
    [institutions]
  );
  const unlinked = institutions
    .filter((inst) => inst.manual)
    .flatMap((inst) =>
      inst.accounts
        .filter((a) => isInvestmentType(a.type))
        .map((a) => ({ a, words: `${withMask(a.name, a.mask)} (${inst.connector ? `through ${connectorLabel(inst.connector)}` : 'manual'})` }))
    );

  // Keys as `item:account`, the order the tab lists them in.
  const keys = linked.map((l) => l.key).join('\n');
  const [histories, setHistories] = useState<Record<string, BalancePoint[]> | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [activities, setActivities] = useState<Record<string, ActivityState>>({});
  const [picked, setPicked] = useState<RangeKey | null>(null);
  // A preset follows its accounts as they come and go; a set the person
  // checked keeps to its own.
  const [choice, setChoice] = useState<{ preset: string } | { keys: readonly string[] }>({ preset: 'all' });
  const [infoOpen, setInfoOpen] = useState(false);
  const infoId = useId();
  // Which accounts are retirement ones can be the person's choice (Plan >
  // Allocation), read once there is a choice of accounts to make.
  const settings = useSettingsRead(linked.length > 1);

  useEffect(() => {
    const ids = keys ? keys.split('\n').map((k) => k.slice(k.indexOf(':') + 1)) : [];
    if (ids.length === 0) return;
    let cancelled = false;
    const reads: string[][] = [];
    for (let i = 0; i < ids.length; i += IDS_PER_READ) reads.push(ids.slice(i, i + IDS_PER_READ));
    Promise.all(
      reads.map((list) =>
        fetch(`/api/account-history?ids=${encodeURIComponent(list.join(','))}`).then((res) => {
          if (!res.ok) throw new Error(`account-history ${res.status}`);
          return res.json() as Promise<{ histories?: Record<string, BalancePoint[]> }>;
        })
      )
    )
      .then((parts) => {
        if (cancelled) return;
        setHistories(Object.assign({}, ...parts.map((p) => p.histories ?? {})));
        setHistoryFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setHistories(null);
        setHistoryFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [keys, refreshKey]);

  useEffect(() => {
    if (!keys) return;
    let cancelled = false;
    const load = (key: string) => {
      const at = key.indexOf(':');
      return loadInvestmentActivity(key.slice(at + 1), key.slice(0, at)).then(
        (data) => {
          if (!cancelled) setActivities((m) => ({ ...m, [key]: { state: 'ready', data } }));
        },
        () => {
          if (!cancelled) setActivities((m) => ({ ...m, [key]: { state: 'failed' } }));
        }
      );
    };
    // One account per connection first: its sync brings the connection's
    // store up to date, and the rest then read it without asking Plaid.
    const byItem = new Map<string, string[]>();
    for (const key of keys.split('\n')) {
      const item = key.slice(0, key.indexOf(':'));
      byItem.set(item, [...(byItem.get(item) ?? []), key]);
    }
    for (const [first, ...rest] of byItem.values()) void load(first).then(() => Promise.all(rest.map(load)));
    // A save of money in and out: that account again, its totals with it.
    const stop = onMoneyInOutSaved((key) => {
      if (keys.split('\n').includes(key)) void load(key);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [keys, refreshKey]);

  const buckets = useMemo(() => overridesOf(settings?.value ?? null).buckets, [settings]);
  const accounts = useMemo(
    (): Shown[] =>
      linked.map(({ inst, a, key }) => {
        const raw = activities[key] ?? LOADING;
        const points = histories?.[a.account_id] ?? null;
        // Through the seam the account's chart uses, so the two agree: the
        // months' ends before its first recorded day, their deposits and
        // withdrawals before Nya's activity.
        const data = raw.state === 'ready' ? raw.data : null;
        const past = data && points ? withPastMonths(points, data, data.investment_months, a.currency) : null;
        return {
          key,
          account_id: a.account_id,
          item_id: inst.item_id,
          currency: a.currency,
          activity: past && data ? { state: 'ready', data: { ...data, flows: past.flows, flows_from: past.flows_from, totals_from: past.totals_from } } : raw,
          points: past ? past.points : points,
          name: a.name,
          mask: a.mask,
          title: withMask(a.name, a.mask),
          institution: inst.institution_name,
          retirement: isRetirement(a.subtype, buckets.get(a.account_id)),
          raw,
          past,
        };
      }),
    [linked, activities, histories, buckets]
  );

  // The chooser: presets for all of them, and for the retirement ones or the
  // others when both kinds are there, and any set of accounts.
  const kindsKey = accounts.map((a) => `${a.key}\t${a.retirement ? 'r' : ''}`).join('\n');
  const presets = useMemo((): ChooserPreset[] => {
    const all = accounts.map((a) => a.key);
    const retirement = accounts.filter((a) => a.retirement).map((a) => a.key);
    if (retirement.length === 0 || retirement.length === all.length) return [{ value: 'all', name: 'All accounts', keys: all }];
    return [
      { value: 'all', name: 'All accounts', keys: all },
      { value: 'retirement', name: 'Retirement', note: 'Tax-deferred and Roth', keys: retirement },
      { value: 'other', name: 'Non-retirement', note: 'Brokerage, HSA, 529 and the rest', keys: accounts.filter((a) => !a.retirement).map((a) => a.key) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by the accounts' keys and kinds alone
  }, [kindsKey]);
  const kinds = presets.length > 1;

  // A set whose accounts have all gone shows every account again.
  const picks = useMemo(() => {
    const keys = 'preset' in choice ? (presets.find((p) => p.value === choice.preset) ?? presets[0]).keys : choice.keys;
    const set = new Set(keys);
    const chosen = accounts.filter((a) => set.has(a.key));
    return chosen.length > 0 ? chosen : accounts;
  }, [accounts, choice, presets]);
  const preset = presetOf(presets, picks.map((a) => a.key))?.value ?? null;
  const historyLoading = histories === null && !historyFailed;
  const s = useMemo(() => summarizeGrowth<Shown>(picks, picked, main, historyLoading), [picks, picked, main, historyLoading]);

  // Manual and SimpleFIN or Lunch Flow accounts under the preset shown; a set
  // of accounts chosen one by one has none.
  const notCounted = unlinked
    .filter(({ a }) => {
      if (preset === 'all') return true;
      if (preset === 'retirement' || preset === 'other') return isRetirement(a.subtype, buckets.get(a.account_id)) === (preset === 'retirement');
      return false;
    })
    .map((u) => u.words);
  const notCountedNotice = notCounted.length > 0 && (
    <Notice level="info">
      {`Not counted: ${joinNames(notCounted)}. Nya has no investment activity for ${notCounted.length === 1 ? 'it' : 'them'}.`}
    </Notice>
  );

  const g = s.groups[0] ?? null;
  const chart = g?.chart ?? null;
  const baseline = chart?.baseline ?? null;
  const baselineFor = useCallback(() => baseline, [baseline]);
  const one = picks.length === 1;
  const info = useMemo(() => (g ? heroInfo(g, one) : []), [g, one]);
  const outside = useMemo(() => ({ infoId, infoOpen, info }), [infoId, infoOpen, info]);
  const drawn = !!chart && !historyFailed && chart.points.length >= 2;
  // The chart writes amounts (its label, its value, its table): drawn again
  // when they are hidden or shown.
  const hidden = useAmountsHidden();
  const chartEl = useMemo(
    () =>
      drawn && chart && g ? (
        <NetWorthChart
          points={chart.points}
          label="Balance"
          baselineFor={baselineFor}
          currency={g.currency}
          rangeSet="investment"
          hero
          outside={outside}
          ranges={s.ranges}
          range={s.range}
          onRange={setPicked}
        />
      ) : null,
    [drawn, chart, g, baselineFor, outside, s.ranges, s.range, hidden]
  );

  if (accounts.length === 0) {
    return (
      <section className="card stack" aria-labelledby="investments-title">
        <div className="card-header">
          <h2 id="investments-title">Investment returns</h2>
        </div>
        <p className="empty-note">Linked investment accounts show their returns here.</p>
        {notCountedNotice}
      </section>
    );
  }

  const several = s.groups.length > 1;
  const switcher = s.ranges.length > 1 && (
    <Segmented compact className="chart-range-switch" label="Time range" value={s.range} onChange={setPicked} options={s.ranges.map((key) => [key, RANGE_TEXT[key]] as const)} />
  );

  return (
    <>
      {accounts.length > 1 && (
        <div className="chip-row">
          <AccountsChooser
            accounts={accounts.map((a) => ({
              key: a.key,
              name: a.name,
              mask: a.mask,
              sub: kinds ? `${a.institution} · ${a.retirement ? 'Retirement' : 'Non-retirement'}` : a.institution,
            }))}
            presets={presets}
            shown={picks.map((a) => a.key)}
            onChoose={(keys, value) => setChoice(value ? { preset: value } : { keys })}
          />
        </div>
      )}

      <InvestmentsHero
        group={g}
        loading={!g || g.loading}
        rangeWords={s.label}
        infoButton={
          drawn ? (
            <button
              type="button"
              className="chart-info-btn"
              aria-label="About this chart"
              aria-expanded={infoOpen}
              aria-controls={infoId}
              onClick={() => setInfoOpen((o) => !o)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <circle cx="8" cy="5" r="0.9" fill="currentColor" />
                <path d="M8 7.2v4.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          ) : null
        }
        chart={
          chartEl ?? (
            <>
              {g && !g.loading && !historyFailed && <p className="empty-note">Not enough history to draw yet: it builds as balances are recorded.</p>}
              {(!g || g.loading) && !historyFailed && (
                <div className="chart-loading" aria-hidden="true">
                  <div className="chart-loading-box" />
                </div>
              )}
              {switcher}
            </>
          )
        }
      >
        {historyFailed && (
          <Notice level="critical" role="alert">
            The accounts’ balance history couldn’t be loaded just now, so their returns over a range can’t be worked out. Refresh to try again.
          </Notice>
        )}
        {g && !historyFailed && <Qualifiers group={g} />}
        {notCountedNotice}
        {several && g && (
          <p className="helper">{`In ${currencyPlural(g.currency)}. Accounts in other currencies are added up on their own, below: nothing here is converted.`}</p>
        )}
      </InvestmentsHero>

      {!historyFailed &&
        s.groups.map((group, i) => (
          <RangeCard
            key={group.currency}
            group={group}
            range={s.range}
            title={rangeTitle(group, s.label, several)}
            // The hero says the home currency's; each other one says its own.
            qualifiers={i > 0}
            onOpenAccount={onOpenAccount}
            onMoneyInOut={onMoneyInOut}
          />
        ))}
    </>
  );
}

/** The card's title: "All time", or the range's words; with the currency
 *  when there are several. */
function rangeTitle(g: CurrencyGroup<Shown>, label: string, several: boolean): string {
  const words = g.basis === 'all' ? 'All time' : label || 'All';
  return several ? `${currencyPlural(g.currency)}, ${words.charAt(0).toLowerCase()}${words.slice(1)}` : words;
}

/** The accounts whose figures reach into their imported months: before
 *  Nya's activity (`activity_from`), with that day. */
function monthsIn(g: CurrencyGroup<Shown>): { title: string; day: string }[] {
  return g.rows.flatMap((r) => {
    const applied = r.account.past?.applied;
    const from = r.split?.from ?? null;
    return applied && from !== null && from < applied.activity_from ? [{ title: r.account.title, day: applied.activity_from }] : [];
  });
}

/** The accounts whose line reaches into their imported months' ends, with
 *  where those stop: before the first recorded day when they're joined to
 *  it, else until their last end (lib/investment-months.ts `applied`). */
function endsIn(g: CurrencyGroup<Shown>): { title: string; joined: boolean; day: string }[] {
  return g.rows.flatMap((r) => {
    const a = r.account.past?.applied;
    const from = r.split?.from ?? null;
    if (!a || from === null || (a.joined ? from >= a.first_recorded : from > a.entered_to)) return [];
    return [{ title: r.account.title, joined: a.joined, day: a.joined ? a.first_recorded : a.entered_to }];
  });
}

/** The hero's lines in the chart's info, before the chart's own. */
function heroInfo(g: CurrencyGroup<Shown>, one: boolean): string[] {
  const these = one ? 'this account' : 'these accounts';
  // Where a line is each month's end from Vanguard's Performance page.
  const ends = endsIn(g)
    .map((m) =>
      one
        ? ` ${m.joined ? `Before ${day(m.day)}, the first recorded day,` : `Until ${day(m.day)},`} it is each month’s end from Vanguard’s Performance page.`
        : ` ${m.title}’s, ${m.joined ? 'before' : 'until'} ${day(m.day)}, is each month’s end from Vanguard’s Performance page.`
    )
    .join('');
  const gold = `Gold line: the balance of ${these}.${ends}`;
  const middles = monthsIn(g)
    .map((m) => (one ? ` Until ${day(m.day)}, Vanguard gives one figure a month, so each counts from the middle of its month.` : ` For ${m.title}, until ${day(m.day)}, Vanguard gives one figure a month, so each counts from the middle of its month.`))
    .join('');
  if (g.basis === 'all') {
    const first = g.chart?.baseline[0]?.date ?? null;
    const startsLater = !!first && !!g.chart && g.chart.points[0].date < first;
    const from = first ? ` from ${day(first)}${startsLater ? `, the first day Nya has ${one ? 'its' : 'every account’s'} activity` : ''}` : '';
    const typed = g.rows.filter((r) => r.figures && r.totals === 'set');
    const source = typed.length === 0 ? '' : typed.length === g.rows.filter((r) => r.figures).length ? ', from the totals you set' : ', from the totals you set and the months you imported';
    return [
      `${gold} Grey line: your deposits less withdrawals since ${one ? 'it' : 'each account'} opened${source}, by each day${from}. The gap between them is your investment returns so far.`,
      g.rate
        ? `The rate of return weighs each deposit and withdrawal by how long it was invested.${middles} Past a year it is given a year.`
        : typed.length === g.rows.filter((r) => r.figures).length
          ? 'There’s no rate of return for all time: Nya doesn’t know when the money before its records went in.'
          : typed.length > 0
            ? `There’s no rate of return for all time across these accounts: Nya doesn’t know when the money before its records went in for ${joinNames(typed.map((r) => r.account.title))}.`
            : '',
    ].filter(Boolean);
  }
  return [
    `${gold} Grey line: what ${one ? 'it' : 'they'} would be worth without returns, the beginning balance plus deposits and withdrawals so far. The gap between them is your investment returns.`,
    `The rate of return weighs each deposit and withdrawal by how long it was invested, so money added late in the range counts for less.${one ? '' : ' An account counted from a later day joins on that day.'}${middles} Past a year it is given a year.`,
  ];
}

/** What qualifies a group's figures, said with them: what they are short
 *  of (critical, in full), where an account starts or stops, and what isn't
 *  counted in the range. */
function Qualifiers({ group: g }: { group: CurrencyGroup<Shown> }) {
  if (g.loading) return null;
  const short = shortWords(g);
  // For all time every account counts from when it opened: only where one
  // stops is said.
  const edges = g.rows.flatMap((r) => edgeWords(r, g.basis === 'all') ?? []);
  return (
    <>
      {short && (
        <Notice level="critical" role="alert">
          {short}
        </Notice>
      )}
      {edges.map((words) => (
        <p key={words} className="helper">
          {words}
        </p>
      ))}
      {g.uncounted.map((r) => (
        <p key={r.account.key} className="helper">
          {`${r.account.title} isn’t counted for this range: it has no recorded day in it that Nya has activity for.`}
        </p>
      ))}
    </>
  );
}

/**
 * The hero: the returns over the range, the rate of return and the chart.
 * The day a finger is on in the chart is held here (components/
 * hero-scrub.ts), so a pointer move re-renders the hero, never the screen;
 * the chart is built by the screen and passed in, the same element each
 * time, so it isn't drawn again.
 */
function InvestmentsHero({
  group: g,
  loading,
  rangeWords,
  infoButton,
  chart,
  children,
}: {
  group: CurrencyGroup<Shown> | null;
  loading: boolean;
  /** The range in words: "Year to date", "Since Jan 1". */
  rangeWords: string;
  infoButton: ReactNode;
  chart: ReactNode;
  children?: ReactNode;
}) {
  const [reading, setReading] = useState<HeroReading | null>(null);
  const f = loading ? null : (g?.figures ?? null);
  const currency = g?.currency ?? null;
  const all = g?.basis === 'all';

  // A day on the chart: the returns to it, the gap between the lines there;
  // two days measured: the returns between them.
  let shown = f?.returns ?? null;
  let dayLine: string | null = null;
  if (reading && f && g) {
    const balance = `balance ${formatMoney(reading.value, currency)}`;
    const estimated = reading.estimated || !!reading.from?.estimated;
    // Over a range, the returns count from the first day an account is
    // counted (the span's), which can be after the chart starts.
    const counts = all ? null : (g.span?.from ?? null);
    if (reading.base == null || (reading.from && reading.from.base == null)) {
      const first = g.chart?.baseline[0]?.date;
      dayLine = `${reading.from ? `${reading.from.day} to ` : ''}${reading.day} · ${balance}${first ? ` · returns count from ${day(first)}` : ''}`;
    } else {
      // To the cent, so a measure across a flat stretch is $0.00, never −$0.00.
      shown = Math.round((reading.value - reading.base - (reading.from ? reading.from.value - reading.from.base! : 0)) * 100) / 100 || 0;
      const before = !reading.from && counts !== null && !!reading.date && reading.date < counts;
      const from = reading.from ? reading.from.day : before ? null : counts !== null ? day(counts) : null;
      // After "to", in a sentence's case ("Jun 1 to yesterday").
      const to = from && reading.date ? day(reading.date) : reading.day;
      dayLine = `${from ? `${from} to ` : ''}${to} · ${balance}${estimated ? ' · estimated' : ''}${before ? ` · returns count from ${day(counts!)}` : ''}`;
    }
  }

  let figure: ReactNode;
  if (loading)
    figure = (
      <span role="status">
        <span className="visually-hidden">Loading investment returns</span>
        <span className="skeleton accounts-skeleton-figure" aria-hidden="true" />
      </span>
    );
  // Words, never "--", at the answer's smaller size: what stands in the way
  // is said under it.
  else if (shown === null) figure = 'Nothing to count yet';
  else figure = <HeroFigure worth={shown} currency={currency} signed />;

  let delta: ReactNode = null;
  if (f && g) {
    // All time has a rate only from months that say when the money went in.
    if (all && !g.rate) delta = <div className="hero-delta">All time, since each account opened</div>;
    else {
      const span = all && g.span ? `since ${monthText(g.span.from.slice(0, 7))}` : `${rangeWords.charAt(0).toLowerCase()}${rangeWords.slice(1)}`;
      const r = g.rate;
      if (!r) delta = <div className="hero-delta">{rangeWords}</div>;
      else {
        const pct = ratePct(r);
        const dir = pct === '0.0%' ? 'flat' : r.value > 0 ? 'up' : 'down';
        delta = (
          <div className={`hero-delta ${dir}`}>
            <b>
              {dir === 'up' ? '▲ ' : dir === 'down' ? '▼ ' : ''}
              {pct}
              {r.annual ? ' a year' : ''}
            </b>{' '}
            rate of return · {span}
          </div>
        );
      }
    }
  }

  return (
    <Hero
      id="investment-returns-title"
      label="Investment returns"
      labelEnd={infoButton}
      className="investments-hero"
      figure={figure}
      figureClass={!loading && shown === null ? 'plan-answer' : undefined}
      line={
        <div className={`hero-line${dayLine ? ' scrubbed' : ''}`}>
          {delta}
          {dayLine && (
            <p className="hero-day">
              <Masked>{dayLine}</Masked>
            </p>
          )}
        </div>
      }
    >
      {children}
      <HeroScrub.Provider value={setReading}>
        <div>{chart}</div>
      </HeroScrub.Provider>
    </Hero>
  );
}

/** Where a row counts from, and why. */
function fromWords(e: NonNullable<GrowthRow['from']>): string {
  if (e.cause === 'opened') return `from ${monthText(e.day.slice(0, 7))}, when it opened`;
  if (e.cause === 'months') return `from ${monthText(e.day.slice(0, 7))}, its first month from Vanguard’s Performance page`;
  // A month's end is on the next month's 1st.
  if (e.cause === 'month-end') return `from the end of ${monthText(previousMonth(e.day.slice(0, 7)))}, the first balance in the range from Vanguard’s Performance page`;
  return `from ${day(e.day)}, ${e.cause === 'recorded' ? 'its first recorded day' : 'the first day Nya has its activity'}`;
}

/** "Individual ••4421 counts from Jul 12, its first recorded day, to Nov 9,
 *  the last day Nya has its activity"; for all time, only where it stops. */
function edgeWords(r: GrowthRow<Shown>, toOnly: boolean): string | null {
  const from = !toOnly && r.from && fromWords(r.from);
  const to = r.to && `to ${day(r.to.day)}, ${r.to.cause === 'activity' ? 'the last day Nya has its activity' : 'its last recorded day'}`;
  if (!from && !to) return null;
  return `${r.account.title} counts ${[from, to].filter(Boolean).join(', ')}.`;
}

/** What the figures are short of, in full. */
function shortWords(g: CurrencyGroup<Shown>): string | null {
  const names = (rows: GrowthRow<Shown>[]) => joinNames(rows.map((r) => r.account.title));
  const failed = g.failed.length > 0 && `${names(g.failed)}: ${its(g.failed.length)} activity couldn’t be loaded just now.`;
  const busy = g.busy.length > 0 && `${names(g.busy)}: ${its(g.busy.length)} activity is still loading, so refresh in a moment.`;
  if (failed && busy) return `These figures leave out ${failed} They also leave out ${busy}`;
  if (failed || busy) return `These figures leave out ${failed || busy}`;
  return null;
}

/** On All short of all time: what to set, and where All counts from. */
function missingWords(g: CurrencyGroup<Shown>): string | null {
  const unset = g.missing.filter((r) => r.totals === 'unset').map((r) => r.account.title);
  const outdated = g.missing.filter((r) => r.totals === 'outdated').map((r) => r.account.title);
  const see = 'to see all time for these accounts';
  let ask: string;
  if (unset.length && outdated.length) ask = `Set deposits and withdrawals for ${joinNames(unset)}, and change them for ${joinNames(outdated)}, ${see}.`;
  else if (unset.length) ask = `Set deposits and withdrawals for ${joinNames(unset)} ${see}.`;
  else if (outdated.length)
    ask = `Change deposits and withdrawals for ${joinNames(outdated)} ${see}: ${outdated.length === 1 ? 'its totals are' : 'their totals are'} for a day before the activity Nya now has.`;
  else return null;
  if (!g.span) return ask;
  return `${ask} Until then, All counts from ${day(g.span.from)}${g.span.from === g.firstRecorded ? ', the first recorded day' : ''}.`;
}

const WHY_DW =
  'Deposits & withdrawals is the money that went into these accounts less the money that came out, so a negative amount means more came out than went in. Rollovers, 401(k) loan repayments and employer contributions count, and so does money moved in from or out to an account you haven’t chosen; money moved between the accounts you chose cancels out. Money that left an account and came back within five days, as a fund exchange or a sweep does, is neither. Dividends, interest and gains are returns, not deposits, and fees come off returns.';

/** The card's Why on all time: where it starts, what it counts from, and
 *  whether it has a rate. */
function allTimeWhy(g: CurrencyGroup<Shown>): string {
  const counted = g.rows.filter((r) => r.figures);
  const typed = counted.filter((r) => r.totals === 'set');
  const opened = `All time starts at ${formatMoney(0, g.currency)}, when ${counted.length === 1 ? 'the account' : 'each account'} opened`;
  const from =
    typed.length === counted.length
      ? `${opened}, and counts from the deposits and withdrawals you set for each account, carried through the activity Nya has had since.`
      : typed.length === 0
        ? `${opened}, and counts from the months you imported from Vanguard’s Performance page, then the activity Nya has had since.`
        : `${opened}, and counts from the deposits and withdrawals you set or the months you imported from Vanguard’s Performance page, carried through the activity Nya has had since.`;
  const middles = monthsIn(g)
    .map((m) => ` Before ${day(m.day)}, when Nya’s activity for ${counted.length === 1 ? 'this account' : m.title} starts, each month’s figures are Vanguard’s.`)
    .join('');
  const rate = g.rate || typed.length === 0 ? '' : ' There’s no rate of return for all time: Nya doesn’t know when the money before its records went in.';
  return `${from}${middles} ${WHY_DW}${rate}`;
}

/** Where all time's figures come from: the totals set, or the months
 *  imported and then Nya's activity, for each account. */
function allTimeHelper(g: CurrencyGroup<Shown>): string {
  const counted = g.rows.filter((r) => r.figures);
  if (counted.every((r) => r.totals === 'set')) return 'Since each account opened, from the deposits and withdrawals you set for it.';
  const months = (r: GrowthRow<Shown>) => {
    const a = r.account.past?.applied;
    return a && a.activity_from > a.from ? `Vanguard’s months until ${day(a.activity_from)}, then Nya’s activity` : 'Nya’s activity';
  };
  if (counted.length === 1) return `Since ${monthText(counted[0].split!.from.slice(0, 7))}, when the account opened: ${months(counted[0])}.`;
  const parts = counted.map((r) => `${r.account.title}’s from ${r.totals === 'set' ? 'the deposits and withdrawals you set' : months(r)}`);
  return `Since each account opened: ${parts.join('; ')}.`;
}

/** The range's card for one currency: its four figures, what they count and
 *  why, then a row for each account. */
function RangeCard({
  group: g,
  range,
  title,
  qualifiers,
  onOpenAccount,
  onMoneyInOut,
}: {
  group: CurrencyGroup<Shown>;
  range: RangeKey;
  title: string;
  /** Say what qualifies the figures here (a currency the hero isn't). */
  qualifiers: boolean;
  onOpenAccount: (item_id: string, account_id: string) => void;
  onMoneyInOut: (target: MoneyInOutTarget) => void;
}) {
  const titleId = useId();
  // Where focus goes after a save from the Set button, which the save
  // usually takes away.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const all = g.basis === 'all';
  const f = g.loading ? null : g.figures;
  // On All, what stands between it and all time.
  const onAll = range === 'ALL' && !all && !g.loading;
  const missing = onAll ? missingWords(g) : null;
  const one = missing && g.missing.length === 1 ? g.missing[0] : null;
  const waiting = onAll && g.failed.length + g.busy.length > 0 ? joinNames([...g.failed, ...g.busy].map((r) => r.account.title)) : null;

  let helper: string | null = null;
  if (f && all) helper = allTimeHelper(g);
  else if (f && g.span) {
    const late = g.rows.filter((r) => r.figures && r.from).map((r) => `${r.account.title}’s beginning balance is its ${day(r.from!.day)} balance.`);
    helper = [`${day(g.span.from)} to ${day(g.span.to)}.`, ...late].join(' ');
  }

  return (
    <section className="card stack" aria-labelledby={titleId}>
      <div className="card-header">
        <h2 id={titleId} tabIndex={-1} ref={titleRef}>
          {title}
        </h2>
      </div>
      <div className="stack tight" {...(g.loading ? { role: 'status', 'aria-label': 'Loading investment activity' } : {})}>
        {g.loading ? <StripSkeleton /> : f ? <Strip f={f} currency={g.currency} /> : <p className="empty-note">Nothing to count in this range yet.</p>}
        {helper && <p className="helper">{helper}</p>}
      </div>
      {qualifiers && <Qualifiers group={g} />}
      {missing && (
        <div className="stack tight">
          <p className="helper">{missing}</p>
          {one && (
            <div>
              <button
                type="button"
                className="btn ghost"
                onClick={(e) => {
                  focusInsteadOf(e.currentTarget, () => titleRef.current);
                  onMoneyInOut(targetFor(one));
                }}
              >
                {`${one.totals === 'outdated' ? 'Change' : 'Set'} deposits and withdrawals`}
              </button>
            </div>
          )}
        </div>
      )}
      {waiting && <p className="helper">{`All time is shown once Nya has the activity for ${waiting}.`}</p>}
      {onAll && g.unreadable.length > 0 && (
        // Never a button here: a save would write over what is stored.
        <Notice level="caution" role="status">
          {`Deposits and withdrawals for ${joinNames(g.unreadable.map((r) => r.account.title))} can’t be read just now, so all-time returns across these accounts aren’t shown.`}
        </Notice>
      )}
      <Why>
        <Masked>
          {all
            ? allTimeWhy(g)
            : `${WHY_DW}${monthsIn(g)
                .map((m) => ` Before ${day(m.day)}, when Nya’s activity for ${g.rows.length === 1 ? 'this account' : m.title} starts, each month’s figures are Vanguard’s, from the Performance page you imported.`)
                .join('')}`}
        </Masked>
      </Why>
      {g.rows.length > 1 && (
        <>
          <h3 className="section-label">By account</h3>
          <ul className="list-rows">
            {g.rows.map((r) => (
              <li key={r.account.key}>
                <Row row={r} currency={g.currency} loading={g.loading} all={all} onOpen={() => onOpenAccount(r.account.item_id, r.account.account_id)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The form's target for a counted account (components/MoneyInOutSheet.tsx). */
function targetFor(r: GrowthRow<Shown>): MoneyInOutTarget {
  const a = r.account;
  // Nya's own activity, which the totals are set against, never the months.
  const data = a.raw.state === 'ready' ? a.raw.data : null;
  return {
    account_id: a.account_id,
    item_id: a.item_id,
    label: `${a.title} · ${a.institution}`,
    currency: a.currency,
    totals: data?.money_in_out ?? null,
    flows: data?.flows ?? [],
    flows_from: data?.flows_from ?? '',
  };
}

function Row({
  row: r,
  currency,
  loading,
  all,
  onOpen,
}: {
  row: GrowthRow<Shown>;
  currency: string;
  loading: boolean;
  all: boolean;
  onOpen: () => void;
}) {
  const a = r.account;
  const named = nameAndMask(a.name, a.mask);
  let status: string | null = null;
  if (r.status === 'loading') status = 'Loading its activity';
  else if (r.status === 'busy') status = 'Its activity is still loading';
  else if (r.status === 'failed') status = 'Its activity couldn’t be loaded';
  else if (r.status === 'none') status = 'No investment activity yet';
  else if (!r.figures && !loading && a.points) status = 'Nothing to count in this range';
  else if (r.figures && r.from && !all) status = `from ${day(r.from.day)}`;
  const sub = status ? `${a.institution} · ${status}` : a.institution;

  const waiting = !r.figures && (r.status === 'loading' || (r.status === 'counted' && loading));
  return (
    <button className="list-row" onClick={onOpen}>
      <span className="list-row-text">
        <span className="list-row-title">
          {named.name}
          {named.mask && <span className="acct-mask">{` ••${named.mask}`}</span>}
        </span>
        <span className="list-row-sub">{sub}</span>
      </span>
      {r.figures ? (
        <span className="list-row-value money growth-value">
          <Masked>{signedMoney(r.figures.returns, currency)}</Masked>
          <span className="growth-value-label">{r.rate ? `returns · ${ratePct(r.rate)}${r.rate.annual ? ' a year' : ''}` : 'returns'}</span>
        </span>
      ) : (
        waiting && (
          <span className="list-row-value" aria-hidden="true">
            <span className="skeleton accounts-skeleton-total" />
          </span>
        )
      )}
      {CHEVRON}
    </button>
  );
}

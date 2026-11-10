'use client';

// Accounts > Investments' two cards (docs/design/information-architecture.md
// #accounts): what the linked investment accounts did, together and each,
// from their own recorded balances and activity. For each currency on its
// own, never converted:
//   - All-time performance, which no range changes: Money in, Money out, Net
//     and Returns, once every account has money in and out Nya can carry,
//     else what to set;
//   - Performance by period: the same four over a range, then a row for each
//     account, which opens its sheet.
// The numbers are lib/growth-summary.ts's.
//
// It loads every account's balance history in one read (app/api/
// account-history `ids`), and each account's activity through the cache its
// sheet uses (components/InvestmentActivity.tsx), one account per connection
// first: the activity route syncs the connection's whole store, and a second
// request while the first holds it would only be told it is still loading. A
// save of money in and out loads that account again; Refresh loads them all.
//
// What it can't count is said, never left out quietly: an account whose
// activity couldn't be loaded or is still loading in a critical notice under
// the figures it is missing from, and in All-time performance, which waits for
// it; manual and SimpleFIN or Lunch Flow accounts, which have no investment
// activity, in an information notice. Money moved between the accounts is
// taken off both cards' totals, and said under them.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { currencyPlural, formatDay, formatMoney, roundsToNothing, signedMoney } from '@/lib/format';
import { isInvestmentType } from '@/lib/balance';
import { RANGE_TEXT, type RangeKey } from '@/lib/chart-range';
import { connectorLabel } from '@/lib/connectors/types';
import { summarizeGrowth, type ActivityState, type CurrencyGroup, type Figures, type GrowthAccount, type GrowthRow } from '@/lib/growth-summary';
import { joinNames } from '@/lib/month-coverage';
import type { BalancePoint } from '@/lib/growth';
import type { Institution } from './accounts-format';
import { Masked } from './HideAmounts';
import { CHEVRON } from './InstitutionCard';
import { loadInvestmentActivity, onMoneyInOutSaved } from './InvestmentActivity';
import type { MoneyInOutTarget } from './MoneyInOutFigures';
import { Segmented } from './Segmented';
import { focusInsteadOf } from './Sheet';
import { Notice } from './TotalCaveats';
import { Why } from './Why';

/** An account on the card, with what its row and sentences name it by. */
type Shown = GrowthAccount & {
  key: string;
  name: string;
  mask: string | null;
  /** "Roth IRA ••3302" */
  title: string;
  institution: string;
};

/** The most ids one history read takes (app/api/account-history MAX_IDS). */
const IDS_PER_READ = 50;

const day = (iso: string) => formatDay(iso, { sentence: true });

const its = (n: number) => (n === 1 ? 'its' : 'their');

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
  const notCounted = institutions
    .filter((inst) => inst.manual)
    .flatMap((inst) =>
      inst.accounts
        .filter((a) => isInvestmentType(a.type))
        .map((a) => `${a.name}${a.mask ? ` ••${a.mask}` : ''} (${inst.connector ? `through ${connectorLabel(inst.connector)}` : 'manual'})`)
    );

  // Keys as `item:account`, the order the tab lists them in.
  const keys = linked.map((l) => l.key).join('\n');
  const [histories, setHistories] = useState<Record<string, BalancePoint[]> | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [activities, setActivities] = useState<Record<string, ActivityState>>({});
  const [picked, setPicked] = useState<RangeKey | null>(null);
  // All-time performance's heading: where focus goes after a save from its Set
  // button, which the save usually takes away.
  const sinceRef = useRef<HTMLHeadingElement>(null);

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

  const accounts: Shown[] = linked.map(({ inst, a, key }) => ({
    key,
    account_id: a.account_id,
    item_id: inst.item_id,
    currency: a.currency,
    balance: a.balance,
    activity: activities[key] ?? { state: 'loading' },
    points: histories?.[a.account_id] ?? null,
    name: a.name,
    mask: a.mask,
    title: `${a.name}${a.mask ? ` ••${a.mask}` : ''}`,
    institution: inst.institution_name,
  }));
  const s = summarizeGrowth(accounts, picked, main, histories === null && !historyFailed);

  const notCountedNotice = notCounted.length > 0 && (
    <Notice level="info">
      {`Not counted: ${joinNames(notCounted)}. Nya has no investment activity for ${notCounted.length === 1 ? 'it' : 'them'}.`}
    </Notice>
  );

  const several = s.groups.length > 1;
  const unconverted = several && <p className="helper">Each currency is added up on its own: nothing here is converted.</p>;

  return (
    <>
      {accounts.length > 0 && (
        <section className="card stack" aria-labelledby="all-time-title">
          <div className="card-header">
            <h2 id="all-time-title" tabIndex={-1} ref={sinceRef}>
              All-time performance
            </h2>
          </div>
          {s.groups.map((g) => (
            <SinceGroup key={g.currency} group={g} label={several ? currencyPlural(g.currency) : null} backTo={() => sinceRef.current} onMoneyInOut={onMoneyInOut} />
          ))}
          {unconverted}
          <Why>
            All-time performance counts from the money in and out you gave for each account, carried through the activity Nya has had since. Returns are their value today less the net: dividends and interest count, fees come off.
          </Why>
        </section>
      )}
      <section className="card stack" aria-labelledby="by-period-title">
        <div className="card-header">
          <h2 id="by-period-title">Performance by period</h2>
        </div>
        {accounts.length === 0 ? (
          <>
            <p className="empty-note">Linked investment accounts show their returns here.</p>
            {notCountedNotice}
          </>
        ) : (
          <>
            {s.ranges.length > 1 && (
              <Segmented compact label="Time range" value={s.range} onChange={setPicked} options={s.ranges.map((key) => [key, RANGE_TEXT[key]] as const)} />
            )}
            {historyFailed && (
              <Notice level="critical" role="alert">
                The accounts’ balance history couldn’t be loaded just now, so their returns over a range can’t be worked out. Refresh to try again.
              </Notice>
            )}
            {s.groups.map((g, i) => (
              <Group
                key={g.currency}
                group={g}
                label={several ? `${currencyPlural(g.currency)}, ${s.label.charAt(0).toLowerCase()}${s.label.slice(1)}` : s.label}
                figures={!historyFailed}
                onOpenAccount={onOpenAccount}
              >
                {i === 0 && (
                  <>
                    {notCountedNotice}
                    <Why>
                      Money in and money out are what went in and came out over the range, rollovers and transfers included, and net is the one less the other. Money that left and came back within five days is a move, neither in nor out: a fund exchange, a sweep, a transfer between these accounts. Returns are the change in value less the net: dividends and interest count, fees come off.
                    </Why>
                  </>
                )}
              </Group>
            ))}
            {unconverted}
          </>
        )}
      </section>
    </>
  );
}

/** Money in, Money out, Net and Returns, in `currency`. */
function Strip({ f, currency }: { f: Figures; currency: string }) {
  return (
    <ul className="stat-strip" role="list">
      <li className="stat">
        <span className="stat-label">Money in</span>
        <span className="stat-value money">
          <Masked>{formatMoney(f.in, currency)}</Masked>
        </span>
      </li>
      <li className="stat">
        <span className="stat-label">Money out</span>
        <span className="stat-value money">
          <Masked>{formatMoney(f.out, currency)}</Masked>
        </span>
      </li>
      <li className="stat">
        <span className="stat-label">Net</span>
        <span className="stat-value money">
          <Masked>{formatMoney(f.net, currency)}</Masked>
        </span>
      </li>
      <li className="stat">
        <span className="stat-label">Returns</span>
        {/* A gain in green with its sign; a loss keeps the text color with
            its minus, as on an account's sheet. */}
        <span className={`stat-value money${f.growth > 0 && !roundsToNothing(f.growth, currency) ? ' inflow' : ''}`}>
          <Masked>{signedMoney(f.growth, currency)}</Masked>
        </span>
      </li>
    </ul>
  );
}

/** The strip's place while the activity loads. */
function StripSkeleton() {
  return (
    <ul className="stat-strip" aria-hidden="true">
      {['Money in', 'Money out', 'Net', 'Returns'].map((label) => (
        <li key={label} className="stat">
          <span className="stat-label">{label}</span>
          <span className="stat-value">
            <span className="skeleton accounts-skeleton-figure" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "counts from Jul 12, its first recorded day, to Nov 9, the last day Nya
 *  has its activity" */
function edgeWords(r: GrowthRow<Shown>): string | null {
  const from = r.from && `from ${day(r.from.day)}, ${r.from.cause === 'recorded' ? 'its first recorded day' : 'the first day Nya has its activity'}`;
  const to = r.to && `to ${day(r.to.day)}, ${r.to.cause === 'activity' ? 'the last day Nya has its activity' : 'its last recorded day'}`;
  if (!from && !to) return null;
  return `${r.account.title} counts ${[from, to].filter(Boolean).join(', ')}.`;
}

/** What the figures are short of, in full, under them. */
function shortWords(g: CurrencyGroup<Shown>): string | null {
  const names = (rows: GrowthRow<Shown>[]) => joinNames(rows.map((r) => r.account.title));
  const failed = g.failed.length > 0 && `${names(g.failed)}: ${its(g.failed.length)} activity couldn’t be loaded just now.`;
  const busy = g.busy.length > 0 && `${names(g.busy)}: ${its(g.busy.length)} activity is still loading, so refresh in a moment.`;
  if (failed && busy) return `These figures leave out ${failed} They also leave out ${busy}`;
  if (failed || busy) return `These figures leave out ${failed || busy}`;
  return null;
}

/** Why All-time performance isn't shown, and what would show it. */
function missingWords(g: CurrencyGroup<Shown>): string | null {
  const unset = g.missing.filter((r) => r.totals === 'unset').map((r) => r.account.title);
  const outdated = g.missing.filter((r) => r.totals === 'outdated').map((r) => r.account.title);
  const see = 'to see your all-time returns across these accounts';
  if (unset.length && outdated.length) return `Set money in and out for ${joinNames(unset)}, and change them for ${joinNames(outdated)}, ${see}.`;
  if (unset.length) return `Set money in and out for ${joinNames(unset)} ${see}.`;
  if (outdated.length)
    return `Change money in and out for ${joinNames(outdated)} ${see}: ${outdated.length === 1 ? 'its totals are' : 'their totals are'} for a day before the activity Nya now has.`;
  return null;
}

/** What the totals leave out as moves between the accounts, said with them:
 *  the rows each show their own leg. */
function MovedLine({ moved, currency }: { moved: number; currency: string }) {
  if (roundsToNothing(moved, currency)) return null;
  return (
    <p className="helper">
      <Masked>{`Not counted as money in or out: ${formatMoney(moved, currency)} that moved between these accounts.`}</Masked>
    </p>
  );
}

/** All-time performance for one currency: its figures, or why they aren't
 *  shown and what would show them. */
function SinceGroup({
  group: g,
  label,
  backTo,
  onMoneyInOut,
}: {
  group: CurrencyGroup<Shown>;
  /** The currency, when the card has several. */
  label: string | null;
  /** Where focus goes when the Set button is gone: the card's heading. */
  backTo: () => HTMLElement | null;
  onMoneyInOut: (target: MoneyInOutTarget) => void;
}) {
  const missing = g.loading || g.since ? null : missingWords(g);
  const one = g.missing.length === 1 ? g.missing[0] : null;
  const early = g.since ? g.rows.filter((r) => r.since?.to) : [];
  const waiting = g.loading || g.since ? null : waitingWords(g);
  const nothing = !g.loading && !g.since && !waiting && !missing && g.unmeasured.length === 0 && g.unreadable.length === 0;

  return (
    <div className="stack tight" {...(g.loading ? { role: 'status', 'aria-label': 'Loading all-time performance' } : {})}>
      {label && <h3 className="section-label">{label}</h3>}
      {g.loading ? (
        <StripSkeleton />
      ) : (
        g.since && (
          <>
            <Strip f={g.since} currency={g.currency} />
            <MovedLine moved={g.sinceMoved} currency={g.currency} />
            {early.map((r) => (
              <p key={r.account.key} className="helper">
                {`${r.account.title}’s all-time returns are measured on ${day(r.since!.to!)}, as Nya has its activity only to ${day(r.flowsTo!)}.`}
              </p>
            ))}
          </>
        )
      )}
      {waiting && <p className="helper">{waiting}</p>}
      {missing && (
        <>
          <p className="helper">{missing}</p>
          {one && (
            <div>
              <button
                type="button"
                className="btn ghost"
                onClick={(e) => {
                  focusInsteadOf(e.currentTarget, backTo);
                  onMoneyInOut(targetFor(one));
                }}
              >
                {`${one.totals === 'outdated' ? 'Change' : 'Set'} money in and out for ${one.account.title}`}
              </button>
            </div>
          )}
        </>
      )}
      {!g.loading && g.unmeasured.length > 0 && (
        <p className="helper">
          {`Nya has no balance for ${joinNames(g.unmeasured.map((r) => r.account.title))} just now, so all-time returns across these accounts aren’t shown.`}
        </p>
      )}
      {!g.loading && g.unreadable.length > 0 && (
        // Never a button here: a save would write over what is stored.
        <Notice level="caution" role="status">
          {`Money in and out for ${joinNames(g.unreadable.map((r) => r.account.title))} can’t be read just now, so all-time returns across these accounts aren’t shown.`}
        </Notice>
      )}
      {nothing && <p className="empty-note">Nothing to count yet.</p>}
    </div>
  );
}

/** Why All-time performance waits on activity the range's figures are short of
 *  (said in full under them). */
function waitingWords(g: CurrencyGroup<Shown>): string | null {
  const names = (rows: GrowthRow<Shown>[]) => joinNames(rows.map((r) => r.account.title));
  const shown = 'All-time returns across these accounts are shown once Nya has';
  if (g.failed.length > 0 && g.busy.length > 0)
    return `${shown} all their activity. The activity for ${names(g.failed)} couldn’t be loaded just now; for ${names(g.busy)}, it is still loading.`;
  if (g.failed.length > 0) return `${shown} the activity for ${names(g.failed)}: ${its(g.failed.length)} activity couldn’t be loaded just now.`;
  if (g.busy.length > 0) return `${shown} the activity for ${names(g.busy)}: ${its(g.busy.length)} activity is still loading.`;
  return null;
}

/** The range's figures for one currency, then a row for each account. */
function Group({
  group: g,
  label,
  figures,
  onOpenAccount,
  children,
}: {
  group: CurrencyGroup<Shown>;
  label: string;
  /** False when the histories couldn't be read: the card says so once. */
  figures: boolean;
  onOpenAccount: (item_id: string, account_id: string) => void;
  children?: ReactNode;
}) {
  const short = g.loading ? null : shortWords(g);
  const edges = g.loading ? [] : g.rows.flatMap((r) => edgeWords(r) ?? []);

  return (
    <>
      {figures && (
        <div className="stack tight" {...(g.loading ? { role: 'status', 'aria-label': 'Loading investment activity' } : {})}>
          <h3 className="section-label">{label}</h3>
          {g.loading ? (
            <StripSkeleton />
          ) : g.figures ? (
            <>
              <Strip f={g.figures} currency={g.currency} />
              <MovedLine moved={g.moved} currency={g.currency} />
            </>
          ) : (
            <p className="empty-note">Nothing to count in this range yet.</p>
          )}
        </div>
      )}
      {short && (
        <Notice level="critical" role="alert">
          {short}
        </Notice>
      )}
      {figures &&
        edges.map((words) => (
          <p key={words} className="helper">
            {words}
          </p>
        ))}
      {figures &&
        g.uncounted.map((r) => (
          <p key={r.account.key} className="helper">
            {`${r.account.title} isn’t counted for this range: it has no recorded day in it that Nya has activity for.`}
          </p>
        ))}
      {children}
      <ul className="list-rows">
        {g.rows.map((r) => (
          <li key={r.account.key}>
            <Row row={r} currency={g.currency} loading={g.loading} onOpen={() => onOpenAccount(r.account.item_id, r.account.account_id)} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** The form's target for a counted account (components/MoneyInOutSheet.tsx). */
function targetFor(r: GrowthRow<Shown>): MoneyInOutTarget {
  const a = r.account;
  const data = a.activity.state === 'ready' ? a.activity.data : null;
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

function Row({ row: r, currency, loading, onOpen }: { row: GrowthRow<Shown>; currency: string; loading: boolean; onOpen: () => void }) {
  const a = r.account;
  const money = (n: number) => formatMoney(n, currency);
  let moved: string;
  if (r.status === 'loading') moved = 'Loading its activity';
  else if (r.status === 'busy') moved = 'Its activity is still loading';
  else if (r.status === 'failed') moved = 'Its activity couldn’t be loaded';
  else if (r.status === 'none') moved = 'No investment activity yet';
  else if (r.split) {
    const parts = [
      ...(roundsToNothing(r.split.in, currency) ? [] : [`${money(r.split.in)} in`]),
      ...(roundsToNothing(r.split.out, currency) ? [] : [`${money(r.split.out)} out`]),
    ];
    moved = `${parts.length ? parts.join(', ') : 'nothing in or out'}${r.from ? `, from ${day(r.from.day)}` : ''}`;
  } else moved = loading || !a.points ? '' : 'Nothing to count in this range';

  let since: string | null = null;
  if (r.status === 'counted') {
    if (r.totals === 'set' && r.since) {
      since = `All time: net ${money(r.since.net)}${r.since.growth === null ? '' : ` · ${signedMoney(r.since.growth, currency)} returns`}`;
    } else if (r.totals === 'unset') since = 'No money in and out set yet';
    else if (r.totals === 'outdated') since = 'Money in and out need changing';
    else if (r.totals === 'unreadable') since = 'Money in and out can’t be read just now';
  }

  const waiting = r.status === 'loading' || (r.status === 'counted' && !a.points && loading);
  return (
    <button className="list-row" onClick={onOpen}>
      <span className="list-row-text">
        <span className="list-row-title">
          {a.name}
          {a.mask && <span className="acct-mask">{` ••${a.mask}`}</span>}
        </span>
        <span className="list-row-sub">
          <Masked>{moved ? `${a.institution} · ${moved}` : a.institution}</Masked>
        </span>
        {since && (
          <span className="list-row-sub">
            <Masked>{since}</Masked>
          </span>
        )}
      </span>
      {r.split ? (
        <span className="list-row-value money growth-value">
          <Masked>{signedMoney(r.split.growth, currency)}</Masked>
          <span className="growth-value-label">returns</span>
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

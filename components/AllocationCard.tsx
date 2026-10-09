'use client';

// The Allocation section of the Plan tab: what the investment accounts hold
// by asset class and by tax bucket, against the person's target, the stock,
// bond and cash mix the simulation below can take from it, and the mix over
// time from holdings history.
//
// On the Plan tab rather than the Accounts tab: allocation is the input the
// plan's simulation takes its mix from, so the two sit together and the mix
// can be offered where it is used; and the tab loads on demand
// (components/PlanTabLoader.tsx), so the classifier, the fund list and the
// history read cost the other tabs nothing.
//
// What it computes is lib/allocation/: nothing is a guess. A fund Nya's list
// doesn't know, or an account with no positions, is UNCLASSIFIED, shown as
// its own share with what it is and a way to classify it, never folded into
// another class. One currency (the Plan's), with anything in another named
// and left out. The person's choices (an account's bucket, a fund's split, a
// split for an account's unlisted money, a target) are saved whole to
// /api/allocation-settings through lib/whole-list-store.ts, which never lets
// unloaded settings be saved over the real ones; while they are loading or
// can't be read, editing is paused and the figures say they leave them out.
//
// The plan's mix is changed only when the person confirms it, in a sheet
// that shows the plan's mix now, the one from the allocation, and what was
// left out of it: never silently, and never with unclassified money counted
// as stocks or bonds.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { Choice } from './PlanForms';
import { dayName, wholeMoney } from './plan-text';
import {
  BUCKET_COLORS,
  CLASS_COLORS,
  classifiedText,
  gapText,
  mixBasisText,
  mixLeftOutText,
  mixText,
  names,
  noMixText,
  pointsText,
  tenthPct,
} from './allocation-text';
import { createWholeListStore, initialListState, type ListState } from '@/lib/whole-list-store';
import { compactMoney } from '@/lib/format';
import { instantDay } from '@/lib/local-date';
import {
  allocate,
  bankCash,
  drift,
  isMoney,
  planMix,
  shares,
  shownAccounts,
  type AllocHolding,
  type AllocInstitution,
  type Allocation,
  type DriftSlot,
  type PlanMix,
  type SecurityRow,
} from '@/lib/allocation/allocation';
import { BUCKET_NAMES, BUCKET_SLOTS, BUCKET_TEXT, TAX_BUCKETS, type AccountBucket, type TaxBucket } from '@/lib/allocation/buckets';
import { ASSET_CLASSES, CLASS_NAMES, CLASS_WORDS, SLOTS, nameKey, splitProblem, splitText, tenths, type AssetClass, type Slot, type Split } from '@/lib/allocation/classes';
import { fundSplit, type FundEntry } from '@/lib/allocation/funds';
import {
  EMPTY_SETTINGS,
  isAllocationSettings,
  overridesOf,
  withAccountSplit,
  withBucket,
  withFund,
  type AllocationSettings,
} from '@/lib/allocation/settings';
import type { SeriesAccount, SeriesAccountSpan, SeriesDay } from '@/lib/allocation/series';
import type { FirePlan } from '@/lib/fire/plan';

/** The local day recovered balances were observed: the local day of the
 *  instant when the server knew it, else the stored UTC day (as the Plan's
 *  invested assets say it). */
export function fmtDay(day: string, at: string | null): string {
  const local = at && at.slice(0, 10) === day ? instantDay(at) : null;
  return local ?? dayName(day);
}

/** "Oct 9, 3:04 PM": when the balances were loaded, in local time. */
function fmtInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export type AllocationState = {
  settings: ListState<AllocationSettings | null>;
  load: () => Promise<void>;
  save: (next: AllocationSettings) => Promise<boolean>;
  /** Whether the person's settings are in the figures: false while they load
   *  or can't be read, when the figures leave them out. */
  withSettings: boolean;
  alloc: Allocation;
  /** The plan's mix from the allocation, with checking and savings as cash
   *  when the plan counts them. */
  mix: PlanMix;
};

/** The allocation of the accounts the dashboard loaded, with the person's
 *  settings, loaded once per mount. */
export function useAllocation({
  institutions,
  holdings,
  currency,
  includeCash,
}: {
  institutions: AllocInstitution[];
  holdings: AllocHolding[];
  currency: string | null;
  includeCash: boolean;
}): AllocationState {
  const [settings, setSettings] = useState<ListState<AllocationSettings | null>>(initialListState<AllocationSettings | null>(null));
  const store = useMemo(
    () =>
      createWholeListStore<AllocationSettings | null>({
        url: '/api/allocation-settings',
        field: 'settings',
        noun: 'allocation settings',
        empty: null,
        isValid: (v): v is AllocationSettings | null => v === null || isAllocationSettings(v),
        onChange: setSettings,
        reloadHint: 'use Try again below',
      }),
    []
  );
  useEffect(() => {
    void store.load();
  }, [store]);
  const withSettings = settings.status === 'ready';
  const value = withSettings ? settings.value : null;
  const alloc = useMemo(() => allocate({ institutions, holdings, settings: value, currency }), [institutions, holdings, value, currency]);
  const mix = useMemo(() => {
    const bank = includeCash ? bankCash(institutions, currency) : { amount: 0, otherCurrencies: [] };
    return planMix(alloc, bank.amount, bank.otherCurrencies);
  }, [alloc, includeCash, institutions, currency]);
  return { settings, load: store.load, save: (next) => store.save(next), withSettings, alloc, mix };
}

type SheetState =
  | { kind: 'fund'; key: { ticker: string } | { name: string }; label: string; current: Split | null; listed: FundEntry | null }
  | { kind: 'account'; account_id: string; label: string; current: Split | null }
  | { kind: 'bucket'; account_id: string; label: string; bucket: AccountBucket }
  | { kind: 'target' }
  | { kind: 'mix' };

/** The value, or the last one that wasn't null: what a closing drawer keeps
 *  showing while it slides out (as in Dashboard.tsx). */
function useLast<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return last.current;
}

export type AllocationCardProps = {
  allocation: AllocationState;
  plan: FirePlan;
  /** Saves the whole plan; true once the server has it. */
  onSavePlan: (next: FirePlan) => Promise<boolean>;
  /** False while the plan is loading, saving or waiting on a repair. */
  planEditable: boolean;
  /** Every institution, for naming accounts missing from a recorded day. */
  institutions: AllocInstitution[];
  balancesAsOf: string | null;
};

export default function AllocationCard({ allocation, plan, onSavePlan, planEditable, institutions, balancesAsOf }: AllocationCardProps) {
  const { alloc, mix, settings, withSettings } = allocation;
  const [view, setView] = useState<'class' | 'bucket'>('class');
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [opened, setOpened] = useState(0);
  const shown = useLast(sheet);
  const open = (s: SheetState) => {
    setOpened((n) => n + 1);
    setSheet(s);
  };
  const close = () => setSheet(null);
  const currency = alloc.currency;
  const money = (n: number) => wholeMoney(n, currency);
  const editable = withSettings && !settings.saving;
  const current = settings.value ?? EMPTY_SETTINGS;
  // Counts the person's saves, so the mix over time, which the server
  // classifies with the saved splits, is read again after each one.
  const [saves, setSaves] = useState(0);
  const saveSettings = async (next: AllocationSettings) => {
    const ok = await allocation.save(next);
    if (ok) {
      setSaves((n) => n + 1);
      close();
    }
    return ok;
  };
  const accountNames = useMemo(() => new Map(institutions.flatMap((i) => i.accounts.map((a) => [a.account_id, `${a.name} at ${i.name}`] as const))), [institutions]);
  // The accounts the mix over time is of: the ones the allocation above shows.
  const seriesAccounts = useMemo(() => seriesAccountsOf(institutions), [institutions]);
  const hasAccounts = alloc.accounts.length > 0;

  return (
    <div className="card alloc-card">
      <div className="inst-header">
        <div className="inst-name">Allocation</div>
        {hasAccounts && (
          <button className="plan-edit" onClick={() => open({ kind: 'target' })} disabled={!editable}>
            {current.target ? 'Change target' : 'Set a target'}
          </button>
        )}
      </div>
      {settings.status === 'error' && (
        <>
          <div className="error" style={{ marginTop: 0 }}>
            {settings.error}
          </div>
          <p className="panel-note">The figures below leave out the buckets, splits and target you set until they load.</p>
          <button className="secondary" style={{ marginTop: 8 }} onClick={() => void allocation.load()}>
            Try again
          </button>
        </>
      )}
      {settings.saveError && <div className="error">{settings.saveError}</div>}

      {!hasAccounts ? (
        <p className="empty-note">No investment accounts to show. Connect a brokerage or retirement account, or add one by hand on the Accounts tab.</p>
      ) : (
        <>
          <div className="as-of">
            Your investment accounts{balancesAsOf ? `, as loaded ${fmtInstant(balancesAsOf)}` : ''}
            {currency ? `, in ${currency}` : ''}. {withSettings ? '' : 'Loading what you set… '}
          </div>
          <Choice
            label="Allocation by"
            value={view}
            onChange={setView}
            options={[
              ['class', 'Asset class'],
              ['bucket', 'Tax bucket'],
            ]}
          />
          {view === 'class' ? (
            <ClassView alloc={alloc} money={money} editable={editable} settings={current} open={open} />
          ) : (
            <BucketView alloc={alloc} money={money} editable={editable} open={open} />
          )}
          <AllocationNotes alloc={alloc} money={money} />
          <DriftSection alloc={alloc} target={withSettings ? current.target : null} money={money} editable={editable} onSet={() => open({ kind: 'target' })} />
          <MixSection mix={mix} plan={plan} ready={withSettings} editable={planEditable && withSettings} onUse={() => open({ kind: 'mix' })} currency={currency} />
        </>
      )}

      <AllocationHistory currency={currency} version={saves} accounts={seriesAccounts} accountNames={accountNames} />

      <Sheet
        open={!!sheet}
        title={
          shown
            ? shown.kind === 'target'
              ? 'Target allocation'
              : shown.kind === 'mix'
                ? 'Use your allocation in the plan'
                : shown.kind === 'bucket'
                  ? 'Tax bucket'
                  : `Classify ${shown.label}`
            : ''
        }
        onClose={close}
      >
        {shown?.kind === 'fund' && (
          <SplitForm
            key={opened}
            intro={
              shown.listed
                ? `Nya's list has ${shown.label} (${shown.listed.name}) as ${splitText(shown.listed.split)}. A split you set is used instead.`
                : `What ${shown.label} holds, in percents that add up to 100. A target-date or balanced fund's mix is on its fact sheet; its mix moves, so check it now and then.`
            }
            initial={shown.current ?? shown.listed?.split ?? null}
            canRemove={shown.current !== null}
            editable={editable}
            onSave={(split) => saveSettings(withFund(current, shown.key, split))}
            onCancel={close}
          />
        )}
        {shown?.kind === 'account' && (
          <SplitForm
            key={opened}
            intro={`What the money in ${shown.label} that no position explains is in, in percents that add up to 100. It is used for that money only, never for positions the account lists.`}
            initial={shown.current}
            canRemove={shown.current !== null}
            editable={editable}
            onSave={(split) => saveSettings(withAccountSplit(current, shown.account_id, split))}
            onCancel={close}
          />
        )}
        {shown?.kind === 'bucket' && (
          <BucketForm key={opened} label={shown.label} bucket={shown.bucket} editable={editable} onSave={(b) => saveSettings(withBucket(current, shown.account_id, b))} onCancel={close} />
        )}
        {shown?.kind === 'target' && (
          <SplitForm
            key={opened}
            target
            intro="The allocation you aim for, by asset class, in percents that add up to 100. Give stocks either as one share, or as US and international: not both."
            initial={current.target}
            canRemove={current.target !== null}
            editable={editable}
            onSave={(split) => saveSettings({ ...current, target: split })}
            onCancel={close}
          />
        )}
        {shown?.kind === 'mix' && (
          <UseMixForm
            key={opened}
            mix={mix}
            plan={plan}
            currency={currency}
            editable={planEditable && withSettings}
            onConfirm={async (stocksPct, bondsPct) => {
              const ok = await onSavePlan({ ...plan, stocksPct, bondsPct });
              if (ok) close();
              return ok;
            }}
            onCancel={close}
          />
        )}
      </Sheet>
    </div>
  );
}

/** The whole as one bar, a segment per slot in its color, and the rows with
 *  their amounts and shares. Negative amounts (a margin loan) can't be part of
 *  a bar of the whole: they are in the rows, and named under the bar. */
export function ShareTable<K extends string>({
  totals,
  order,
  colors,
  label,
  money,
}: {
  totals: Record<K, number>;
  order: readonly K[];
  colors: Record<K, string>;
  label: (k: K) => string;
  money: (n: number) => string;
}) {
  const rows = shares(totals, order);
  const positive = rows.filter((r) => r.amount > 0);
  const negative = rows.filter((r) => r.amount < 0);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  if (rows.length === 0) return <p className="empty-note">Nothing to show: no balance or position to count.</p>;
  return (
    <>
      <div className="alloc-bar" role="img" aria-label={rows.map((r) => `${label(r.slot)} ${r.label ?? money(r.amount)}`).join(', ')}>
        {positive.map((r) => (
          <span key={r.slot} className="alloc-seg" style={{ flexGrow: r.amount, background: colors[r.slot] }} />
        ))}
      </div>
      <table className="alloc-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.slot}>
              <td>
                <span className="alloc-swatch" style={{ background: colors[r.slot] }} aria-hidden="true" />
                {label(r.slot)}
              </td>
              <td className="num">{money(r.amount)}</td>
              <td className="num alloc-share">{r.label ?? '--'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {negative.length > 0 && (
        <p className="panel-note">
          {names(negative.map((r) => `${label(r.slot)} is below zero (${money(r.amount)})`))}: money owed, such as cash borrowed on margin or a short
          position, so the bar leaves {negative.length === 1 ? 'it' : 'them'} out
          {total > 0 ? ' and the shares are of everything held less what is owed' : ''}.
        </p>
      )}
      {total <= 0 && <p className="panel-note">What is owed is as much as what is held or more, so there are no shares to show, only amounts.</p>}
    </>
  );
}

/** One line: a label and figure, a note and an action under them (the Plan
 *  tab's row). */
function Row({ label, value, note, action }: { label: React.ReactNode; value: React.ReactNode; note?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="plan-row">
      <div className="plan-row-main">
        <span className="plan-row-label">{label}</span>
        <span className="plan-row-value">{value}</span>
      </div>
      {(note || action) && (
        <div className="plan-row-note">
          <span>{note}</span>
          {action}
        </div>
      )}
    </div>
  );
}

function ActionButton({ onClick, disabled, children, label }: { onClick: () => void; disabled: boolean; children: React.ReactNode; label: string }) {
  return (
    <button className="plan-edit" onClick={onClick} disabled={disabled} aria-label={label}>
      {children}
    </button>
  );
}

/** A security's name for its row: its ticker, with its name when it has one
 *  that says more. */
const securityLabel = (s: SecurityRow) => s.ticker ?? s.name ?? 'A holding with no name';

/** The sheet that classifies a security, by its ticker or, with none, its
 *  name; null when it has neither. */
function fundSheet(s: SecurityRow, settings: AllocationSettings): SheetState | null {
  const key: { ticker: string } | { name: string } | null = s.ticker ? { ticker: s.ticker } : s.name ? { name: s.name } : null;
  if (!key) return null;
  const mine = overridesOf(settings).splits;
  const current = 'ticker' in key ? (mine.byTicker.get(key.ticker) ?? null) : (mine.byName.get(nameKey(key.name)) ?? null);
  return { kind: 'fund', key, label: securityLabel(s), current, listed: s.ticker ? fundSplit(s.ticker) : null };
}

export function ClassView({
  alloc,
  money,
  editable,
  settings,
  open,
}: {
  alloc: Allocation;
  money: (n: number) => string;
  editable: boolean;
  settings: AllocationSettings;
  open: (s: SheetState) => void;
}) {
  const unclassifiedSecurities = alloc.securities.filter((s) => !s.classified.split && s.amount !== 0);
  const gaps = alloc.gaps.filter((g) => g.amount !== 0);
  const accountSplits = overridesOf(settings).accounts;
  return (
    <>
      <ShareTable totals={alloc.classes} order={SLOTS} colors={CLASS_COLORS} label={(s: Slot) => CLASS_NAMES[s]} money={money} />
      {(unclassifiedSecurities.length > 0 || gaps.length > 0) && (
        <>
          <div className="plan-subhead">{alloc.classes.unclassified !== 0 ? `Unclassified: ${money(alloc.classes.unclassified)}` : 'Account money no position explains'}</div>
          <p className="panel-note">
            Money Nya can&apos;t place in a class is shown as unclassified, never guessed at. Classify it to count it, here and in the plan&apos;s mix.
          </p>
          <div className="plan-rows">
            {unclassifiedSecurities.map((s) => {
              const sheet = fundSheet(s, settings);
              return (
                <Row
                  key={s.key}
                  label={securityLabel(s)}
                  value={money(s.amount)}
                  note={`${s.name && s.name !== s.ticker ? `${s.name}. ` : ''}${classifiedText(s.classified)}. In ${names(s.accounts)}.`}
                  action={
                    sheet ? (
                      <ActionButton onClick={() => open(sheet)} disabled={!editable} label={`Classify ${securityLabel(s)}`}>
                        Classify
                      </ActionButton>
                    ) : undefined
                  }
                />
              );
            })}
            {gaps.map((g) => (
              <Row
                key={`${g.kind}:${g.account_id}`}
                label={g.account}
                value={money(g.amount)}
                note={`${gapText(g, fmtDay)}.`}
                action={
                  g.kind === 'unreachable' ? undefined : (
                    <ActionButton
                      onClick={() => open({ kind: 'account', account_id: g.account_id, label: g.account, current: accountSplits.get(g.account_id) ?? null })}
                      disabled={!editable}
                      label={`Classify ${g.account}`}
                    >
                      {g.split ? 'Change' : 'Classify'}
                    </ActionButton>
                  )
                }
              />
            ))}
          </div>
        </>
      )}
      {alloc.securities.length > 0 && (
        <details className="plan-table-view">
          <summary>How each holding is classified</summary>
          <div className="plan-rows">
            {alloc.securities.map((s) => {
              const sheet = fundSheet(s, settings);
              return (
                <Row
                  key={s.key}
                  label={securityLabel(s)}
                  value={money(s.amount)}
                  note={`${classifiedText(s.classified)}.`}
                  action={
                    sheet ? (
                      <ActionButton onClick={() => open(sheet)} disabled={!editable} label={`Classify ${securityLabel(s)}`}>
                        {s.classified.split && s.classified.by === 'yours' ? 'Change' : 'Classify'}
                      </ActionButton>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        </details>
      )}
    </>
  );
}

export function BucketView({ alloc, money, editable, open }: { alloc: Allocation; money: (n: number) => string; editable: boolean; open: (s: SheetState) => void }) {
  return (
    <>
      <ShareTable totals={alloc.buckets} order={BUCKET_SLOTS} colors={BUCKET_COLORS} label={(b) => BUCKET_NAMES[b]} money={money} />
      <div className="plan-subhead">Accounts</div>
      <p className="panel-note">
        From each account&apos;s type. A 401(k) can hold Roth money, which its type doesn&apos;t say: change any account that is in another bucket.
      </p>
      <div className="plan-rows">
        {alloc.accounts.map((a) => {
          const b = a.bucket;
          const note =
            b.from === 'you'
              ? `as you set it${b.subtype !== 'unclassified' ? `; its type says ${BUCKET_NAMES[b.subtype].toLowerCase()}` : ''}`
              : b.from === 'subtype'
                ? `from its type${a.subtype ? ` (${a.subtype})` : ''}`
                : a.manual && !a.subtype
                  ? 'unclassified: an account you track by hand has no type to go by'
                  : `unclassified: ${b.why ?? "Nya doesn't know this kind of account"}`;
          return (
            <Row
              key={a.account_id}
              label={`${a.name} · ${a.institution}`}
              value={BUCKET_NAMES[b.bucket]}
              note={`${a.amount !== null ? `${money(a.amount)}${a.staleAsOf ? `, its balance on ${fmtDay(a.staleAsOf, a.staleAsOfAt)} (${a.institution} couldn't be reached since)` : ''}, ` : a.otherCurrency ? `in ${a.otherCurrency}, left out, ` : ''}${note}.`}
              action={
                <ActionButton onClick={() => open({ kind: 'bucket', account_id: a.account_id, label: a.name, bucket: b })} disabled={!editable} label={`Change the bucket of ${a.name}`}>
                  Change
                </ActionButton>
              }
            />
          );
        })}
      </div>
    </>
  );
}

/** What the allocation leaves out or can't see, one sentence each. */
export function AllocationNotes({ alloc, money }: { alloc: Allocation; money: (n: number) => string }) {
  const lines: string[] = [];
  if (alloc.otherCurrencies.length) {
    lines.push(
      `Left out: ${names(alloc.otherCurrencies.map((o) => wholeMoney(o.amount, o.currency)))}, in ${alloc.otherCurrencies.length === 1 ? 'another currency' : 'other currencies'}. Nya doesn't convert currencies.`
    );
  }
  for (const c of alloc.caveats) {
    if (c.kind === 'unreachable') lines.push(`${c.institution} couldn't be reached and isn't counted, so this may be short.`);
    else lines.push(`${c.count} account${c.count === 1 ? '' : 's'} at ${c.institution} couldn't be shown, so this may be short.`);
  }
  for (const o of alloc.over) {
    lines.push(`${o.account}'s positions are worth ${money(o.amount)} more than its balance (a margin loan, or prices from another time): they are counted as listed.`);
  }
  if (alloc.unpriced > 0) lines.push(`${alloc.unpriced} position${alloc.unpriced === 1 ? ' has' : 's have'} no value from the institution, so ${alloc.unpriced === 1 ? "it isn't" : "they aren't"} counted.`);
  if (alloc.noBalance > 0) lines.push(`${alloc.noBalance} account${alloc.noBalance === 1 ? ' has' : 's have'} no balance or position to count.`);
  if (alloc.unattributed > 0) {
    lines.push(`${alloc.unattributed} position${alloc.unattributed === 1 ? ' belongs' : 's belong'} to no account Nya can show, so ${alloc.unattributed === 1 ? "it isn't" : "they aren't"} counted. A refresh usually fixes this.`);
  }
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((l) => (
        <div key={l} className="as-of stale">
          {l}
        </div>
      ))}
    </>
  );
}

const driftLabel = (slot: DriftSlot) => (slot === 'all-stocks' ? 'Stocks' : CLASS_NAMES[slot]);

export function DriftSection({
  alloc,
  target,
  money,
  editable,
  onSet,
}: {
  alloc: Allocation;
  target: Split | null;
  money: (n: number) => string;
  editable: boolean;
  onSet: () => void;
}) {
  if (!target) {
    return (
      <>
        <div className="plan-subhead">Target</div>
        <p className="empty-note">Set the allocation you aim for to see how far yours has drifted from it.</p>
        <button className="secondary" style={{ marginTop: 8 }} onClick={onSet} disabled={!editable}>
          Set a target
        </button>
      </>
    );
  }
  const d = drift(alloc, target);
  return (
    <>
      <div className="plan-subhead">Against your target: {splitText(target)}</div>
      {!d ? (
        <p className="empty-note">
          {splitProblem(target) ? "Your saved target doesn't add up to 100%, so it can't be compared: change it." : 'Nothing is classified yet, so there is nothing to compare.'}
        </p>
      ) : (
        <>
          <table className="alloc-table alloc-drift">
            <thead>
              <tr>
                <th>Class</th>
                <th className="num">Target</th>
                <th className="num">Now</th>
                <th className="num">Drift</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.slot}>
                  <td>
                    {driftLabel(r.slot)}
                    {r.toTarget !== null && Math.abs(r.toTarget) >= 1 && (
                      <div className="alloc-sub">
                        {money(Math.abs(r.toTarget))} {r.toTarget > 0 ? 'under' : 'over'}
                      </div>
                    )}
                  </td>
                  <td className="num">{r.target === null ? '--' : `${r.target}%`}</td>
                  <td className="num">{tenthPct(r.actual)}</td>
                  <td className="num">{r.diff === null ? 'no target' : pointsText(r.diff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.byRegion && d.rows.some((r) => r.slot === 'stocks') && (
            <p className="panel-note">Stocks whose region Nya doesn&apos;t know have no target of their own: classify them to compare US and international exactly.</p>
          )}
          {d.unclassified !== 0 && (
            <p className="panel-note">
              {money(d.unclassified)} unclassified is left out of these shares: it could be in any class. Classify it to compare all of your money.
            </p>
          )}
        </>
      )}
    </>
  );
}

export function MixSection({
  mix,
  plan,
  ready,
  currency,
  editable,
  onUse,
}: {
  mix: PlanMix;
  plan: FirePlan;
  ready: boolean;
  currency: string | null;
  editable: boolean;
  onUse: () => void;
}) {
  const plans = mixText({ stocksPct: plan.stocksPct, bondsPct: plan.bondsPct });
  if (!ready) return null;
  if (!mix.ok) {
    return (
      <>
        <div className="plan-subhead">For your plan</div>
        <p className="panel-note">
          {noMixText(mix)} Your plan&apos;s simulation uses {plans}.
        </p>
      </>
    );
  }
  const same = mix.stocksPct === plan.stocksPct && mix.bondsPct === plan.bondsPct;
  const left = mixLeftOutText(mix, currency);
  return (
    <>
      <div className="plan-subhead">For your plan</div>
      <p className="panel-note">
        {mixBasisText(mix, currency)}: <strong>{mixText(mix)}</strong>. {same ? "Your plan's simulation already uses this mix." : `Your plan's simulation uses ${plans}.`}
      </p>
      {left && <p className="panel-note">{left}</p>}
      {!same && (
        <button className="secondary" style={{ marginTop: 8 }} onClick={onUse} disabled={!editable}>
          Use my allocation in the plan
        </button>
      )}
    </>
  );
}

/** The confirmation before the plan's mix changes: the mix now, the one it
 *  would take, and what that leaves out. Nothing changes until Use it. */
export function UseMixForm({
  mix,
  plan,
  currency,
  editable,
  onConfirm,
  onCancel,
}: {
  mix: PlanMix;
  plan: FirePlan;
  currency: string | null;
  editable: boolean;
  onConfirm: (stocksPct: number, bondsPct: number) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (!mix.ok) return <p className="empty-note">{noMixText(mix)}</p>;
  const left = mixLeftOutText(mix, currency);
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Your plan&apos;s simulation uses <strong>{mixText({ stocksPct: plan.stocksPct, bondsPct: plan.bondsPct })}</strong>. {mixBasisText(mix, currency)}:{' '}
        <strong>{mixText(mix)}</strong>.
      </p>
      {left && <p className="panel-note">{left}</p>}
      <p className="panel-note">
        The plan keeps this mix until you change it: it doesn&apos;t follow your accounts. Stocks of every region count as stocks.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          disabled={!editable || saving}
          onClick={async () => {
            setSaving(true);
            setError('');
            const ok = await onConfirm(mix.stocksPct, mix.bondsPct);
            setSaving(false);
            if (!ok) setError('It was not saved. Try again in a moment.');
          }}
        >
          {saving ? 'Saving…' : `Use ${mix.stocksPct}/${mix.bondsPct}/${mix.cashPct}`}
        </button>
      </div>
    </>
  );
}

/** The fields of a split form, by class: the names a person would use. */
const FIELD_NAMES: Record<AssetClass, string> = {
  'us-stocks': 'US stocks',
  'intl-stocks': 'International stocks',
  bonds: 'Bonds',
  cash: 'Cash',
  stocks: 'Stocks, any region',
  'real-estate': 'Real estate',
  crypto: 'Crypto',
  other: 'Other',
};

/** Percents as typed, into a split: an empty field is none. Throws a message
 *  a person can act on. */
export function readSplit(fields: Partial<Record<AssetClass, string>>, opts: { target?: boolean } = {}): Split {
  const split: Split = {};
  for (const c of ASSET_CLASSES) {
    const t = (fields[c] ?? '').trim();
    if (t === '') continue;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${FIELD_NAMES[c]} must be a percent from 0 to 100.`);
    if (tenths(n) === null) throw new Error(`${FIELD_NAMES[c]} can have one decimal at most.`);
    if (n > 0) split[c] = n;
  }
  const sum = ASSET_CLASSES.reduce((s, c) => s + (tenths(split[c] ?? 0) ?? 0), 0);
  if (sum === 0) throw new Error('Give at least one class a share.');
  if (sum !== 1000) throw new Error(`These add up to ${sum / 10}%: they need to add up to 100%.`);
  if (opts.target && (split.stocks ?? 0) > 0 && ((split['us-stocks'] ?? 0) > 0 || (split['intl-stocks'] ?? 0) > 0)) {
    throw new Error('Give stocks as one share, or as US and international, not both.');
  }
  return split;
}

export function SplitForm({
  intro,
  initial,
  canRemove,
  editable,
  target = false,
  onSave,
  onCancel,
}: {
  intro: string;
  initial: Split | null;
  canRemove: boolean;
  editable: boolean;
  target?: boolean;
  /** Saves the split, or removes it with null; true once the server has it. */
  onSave: (split: Split | null) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState<Partial<Record<AssetClass, string>>>(() =>
    Object.fromEntries(ASSET_CLASSES.map((c) => [c, initial?.[c] !== undefined ? String(initial[c]) : '']))
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  let sum = 0;
  for (const c of ASSET_CLASSES) sum += tenths(Number(fields[c] || 0)) ?? 0;
  const save = async (split: Split | null) => {
    setError('');
    setSaving(true);
    const ok = await onSave(split);
    setSaving(false);
    if (!ok) setError('It was not saved. Try again in a moment.');
  };
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {intro}
      </p>
      <div className="sheet-form alloc-fields">
        {ASSET_CLASSES.map((c) => (
          <label key={c} className="field">
            {FIELD_NAMES[c]} %
            <input type="number" inputMode="decimal" step="0.1" value={fields[c]} onChange={(e) => setFields((f) => ({ ...f, [c]: e.target.value }))} disabled={saving} />
          </label>
        ))}
      </div>
      <p className="panel-note">Adds up to {sum / 10}%{sum === 1000 ? '.' : ': it needs to be 100%.'}</p>
      {error && <div className="error">{error}</div>}
      {canRemove && (
        <button className="danger-outline" style={{ marginTop: 12 }} disabled={!editable || saving} onClick={() => void save(null)}>
          {target ? 'Remove the target' : 'Remove my split'}
        </button>
      )}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          disabled={!editable || saving}
          onClick={() => {
            let split: Split;
            try {
              split = readSplit(fields, { target });
            } catch (err) {
              setError((err as Error).message);
              return;
            }
            void save(split);
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}

export function BucketForm({
  label,
  bucket,
  editable,
  onSave,
  onCancel,
}: {
  label: string;
  bucket: AccountBucket;
  editable: boolean;
  /** Saves the bucket, or goes back to the type's with null. */
  onSave: (b: TaxBucket | null) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<TaxBucket | 'type'>(bucket.from === 'you' ? (bucket.bucket as TaxBucket) : 'type');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fromType = bucket.subtype === 'unclassified' ? `unclassified, since ${bucket.why ?? "Nya doesn't know this kind of account"}` : BUCKET_NAMES[bucket.subtype].toLowerCase();
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        How the money in {label} is taxed. Its type says {fromType}.
      </p>
      <div className="alloc-choices" role="radiogroup" aria-label={`The tax bucket of ${label}`}>
        <label className="plan-check">
          <input type="radio" name="bucket" checked={choice === 'type'} onChange={() => setChoice('type')} disabled={saving} />
          As its type says
        </label>
        {TAX_BUCKETS.map((b) => (
          <label key={b} className="plan-check">
            <input type="radio" name="bucket" checked={choice === b} onChange={() => setChoice(b)} disabled={saving} />
            <span>
              <strong>{BUCKET_NAMES[b]}</strong>: {BUCKET_TEXT[b]}
            </span>
          </label>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          disabled={!editable || saving}
          onClick={async () => {
            setSaving(true);
            setError('');
            const ok = await onSave(choice === 'type' ? null : choice);
            setSaving(false);
            if (!ok) setError('It was not saved. Try again in a moment.');
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}

// Allocation over time

/** An account the answer says was recorded, with the directory's name for
 *  one the dashboard no longer shows. */
export type HistoryAccount = SeriesAccountSpan & { label: string | null };

export type HistoryAnswer = {
  currency: string | null;
  first_recorded: string | null;
  first_recorded_at: string | null;
  last_recorded: string | null;
  days: SeriesDay[];
  accounts: HistoryAccount[];
  /** Recorded days whose balances couldn't be read: not drawn. */
  unreadable_days: string[];
};

export type HistoryState =
  | { kind: 'loading' }
  | { kind: 'ready'; answer: HistoryAnswer }
  /** What is stored can't be read: the server's words, which name it (the
   *  holdings records, or the settings that classify them). */
  | { kind: 'unreadable'; message: string | null }
  | { kind: 'failed' };

/** The accounts the mix over time is worked out for: those today's
 *  allocation shows (lib/allocation/allocation.ts shownAccounts), each with
 *  its currency and whether it is tracked by hand, as allocate reads them. */
export function seriesAccountsOf(institutions: readonly AllocInstitution[]): SeriesAccount[] {
  return institutions.flatMap((i) => shownAccounts(i).map((a) => ({ account_id: a.account_id, currency: a.currency ?? null, manual: i.item_id === null })));
}

/** Whether an answer has the shape this reads. */
function isHistoryAnswer(v: unknown): v is HistoryAnswer {
  const a = v as HistoryAnswer | null;
  return !!a && Array.isArray(a.days) && Array.isArray(a.accounts) && Array.isArray(a.unreadable_days);
}

/** The over-time chart, from /api/allocation-history, for the accounts today's
 *  allocation shows (so both count the same accounts by the same rules), read
 *  again when the person saves a change to their settings (`version`): the
 *  server classifies recorded days with their splits, as they are saved. */
export function AllocationHistory({
  currency,
  version,
  accounts,
  accountNames,
}: {
  currency: string | null;
  version: number;
  accounts: SeriesAccount[];
  accountNames: Map<string, string>;
}) {
  const [state, setState] = useState<HistoryState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // The question as text, so a new list of the same accounts asks nothing new.
  const question = JSON.stringify({ ...(currency ? { currency } : {}), accounts });
  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    fetch('/api/allocation-history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: question })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!live) return;
        if (res.status === 409) setState({ kind: 'unreadable', message: typeof body?.error === 'string' ? body.error : null });
        else if (!res.ok || !isHistoryAnswer(body)) setState({ kind: 'failed' });
        else setState({ kind: 'ready', answer: body });
      })
      .catch(() => {
        if (live) setState({ kind: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [question, version, attempt]);
  return (
    <>
      <div className="plan-subhead">Over time</div>
      <HistoryBody state={state} accountNames={accountNames} onRetry={() => setAttempt((n) => n + 1)} />
    </>
  );
}

/** Each account's name, for the over-time section: the dashboard's for one it
 *  shows, the directory's for one it no longer does. */
function historyNames(answer: HistoryAnswer, accountNames: Map<string, string>): (id: string) => string {
  const labels = new Map(answer.accounts.map((a) => [a.account_id, a.label]));
  return (id) => accountNames.get(id) ?? labels.get(id) ?? 'an account no longer linked';
}

/** Why an account isn't in a day's mix: "not recorded since Oct 2, 2026",
 *  "first recorded on Oct 5, 2026", "not recorded that day". */
export function missingWhy(account: HistoryAccount | undefined, date: string): string {
  if (!account || account.first === null || account.last === null) return 'never recorded';
  if (date < account.first) return `first recorded on ${dayName(account.first)}`;
  if (date > account.last) return `not recorded since ${dayName(account.last)}`;
  return 'not recorded that day';
}

/** The accounts a day's mix leaves out, each with why: for the readout and the
 *  table. */
export function missingOn(day: SeriesDay, answer: Pick<HistoryAnswer, 'accounts'>, nameOf: (id: string) => string): string {
  const spans = new Map(answer.accounts.map((a) => [a.account_id, a]));
  return names(day.missing.map((id) => `${nameOf(id)} (${missingWhy(spans.get(id), day.date)})`));
}

export function HistoryBody({ state, accountNames, onRetry }: { state: HistoryState; accountNames: Map<string, string>; onRetry: () => void }) {
  if (state.kind === 'loading') return <p className="empty-note">Loading what has been recorded…</p>;
  if (state.kind === 'unreadable') {
    return (
      <p className="empty-note">
        {state.message ?? 'What Nya has stored for it could not be read, so they were left untouched.'} The mix over time can&apos;t be shown until it can be
        read.
      </p>
    );
  }
  if (state.kind === 'failed') {
    return (
      <>
        <p className="empty-note">The mix over time couldn&apos;t be loaded.</p>
        <button className="secondary" style={{ marginTop: 8 }} onClick={onRetry}>
          Try again
        </button>
      </>
    );
  }
  const { answer } = state;
  const unreadable = answer.unreadable_days.length;
  const unreadableNote =
    unreadable > 0 ? `${unreadable} recorded day${unreadable === 1 ? '' : 's'} couldn't be read, so ${unreadable === 1 ? "it isn't" : "they aren't"} drawn.` : null;
  if (!answer.first_recorded || answer.days.length === 0) {
    return (
      <>
        <p className="empty-note">
          {unreadable > 0
            ? 'Nothing recorded can be shown yet.'
            : 'Nothing recorded yet. Plaid keeps no past holdings, so Nya records them each day it can fetch them, and the mix over time starts on the first of those days.'}
        </p>
        {unreadableNote && <div className="as-of stale">{unreadableNote}</div>}
      </>
    );
  }
  const nameOf = historyNames(answer, accountNames);
  const days = answer.days;
  const last = days[days.length - 1];
  const spans = new Map(answer.accounts.map((a) => [a.account_id, a]));
  // Accounts the latest day leaves out, with when each was last recorded.
  const behind = last.missing.map((id) => ({ name: nameOf(id), last: spans.get(id)?.last ?? null }));
  const behindNote =
    behind.length === 0
      ? null
      : behind.length === 1
        ? behind[0].last
          ? `${behind[0].name} hasn't been recorded since ${dayName(behind[0].last)}, so the mix on the latest days leaves it out.`
          : `${behind[0].name} hasn't been recorded yet, so the mix leaves it out.`
        : `${names(behind.map((b) => `${b.name} (${b.last ? `since ${dayName(b.last)}` : 'never recorded'})`))} haven't been recorded lately, so the mix on the latest days leaves them out.`;
  const marked = days.filter((d) => d.missing.length > 0);
  const markedIds = [...new Set(marked.flatMap((d) => d.missing))];
  const markedNote =
    marked.length === 0
      ? null
      : `On ${marked.length} day${marked.length === 1 ? '' : 's'} (marked), the mix leaves out ${
          markedIds.length === 1 ? `${nameOf(markedIds[0])}, which wasn't recorded then` : `accounts that weren't recorded then: ${names(markedIds.map(nameOf))}`
        }.`;
  // Accounts the dashboard no longer shows, counted from their positions on
  // the days they were recorded: within their span, and not missing.
  const recordedOn = (a: HistoryAccount, d: SeriesDay) => a.first !== null && a.last !== null && d.date >= a.first && d.date <= a.last && !d.missing.includes(a.account_id);
  const gone = answer.accounts.filter((a) => !a.shown && days.some((d) => recordedOn(a, d)));
  const goneNote =
    gone.length === 0
      ? null
      : `${names(gone.map((a) => nameOf(a.account_id)))} ${gone.length === 1 ? "isn't" : "aren't"} linked now, so on the days ${gone.length === 1 ? 'it was' : 'they were'} recorded ${
          gone.length === 1 ? 'it is' : 'they are'
        } counted from ${gone.length === 1 ? 'its' : 'their'} positions alone.`;
  const other = [...new Set(days.flatMap((d) => Object.keys(d.otherCurrencies)))].sort();
  const noCurrency = days.some((d) => isMoney(d.noCurrency));
  const unlisted = days.some((d) => isMoney(d.unlisted));
  const shownFrom = days[0].date > answer.first_recorded ? days[0].date : null;
  return (
    <>
      <p className="as-of">
        Recorded from {dayName(answer.first_recorded)}
        {shownFrom ? `, shown from ${dayName(shownFrom)}` : ''}, on {days.length} day{days.length === 1 ? '' : 's'}: nothing is drawn before the first, or on a day
        nothing was recorded. Each day is counted as the allocation above is, from the positions and balances recorded that day.
      </p>
      <AllocationHistoryChart days={days} currency={answer.currency} answer={answer} nameOf={nameOf} />
      {behindNote && <div className="as-of stale">{behindNote}</div>}
      {markedNote && <div className="as-of stale">{markedNote}</div>}
      {unlisted && (
        <p className="panel-note">
          Unclassified includes money no position explains: an account tracked by hand, a balance beyond its positions, or an account whose positions didn&apos;t
          come that day. The allocation above names today&apos;s.
        </p>
      )}
      {goneNote && <p className="panel-note">{goneNote}</p>}
      {noCurrency && (
        <div className="as-of stale">Positions with no currency in an account that isn&apos;t linked now are left out: its currency isn&apos;t known.</div>
      )}
      {other.length > 0 && <div className="as-of stale">Money in {names(other)} is left out: Nya doesn&apos;t convert currencies.</div>}
      {unreadableNote && <div className="as-of stale">{unreadableNote}</div>}
    </>
  );
}

const W = 340;
const H = 132;
const PAD_LEFT = 34;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 26;
const DAY_MS = 86_400_000;
const dayNum = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;

/** The share of each class held on a day, of the positive amounts, in the
 *  classes' order: what a column of the chart is drawn from. Rounding
 *  residue holds nothing. */
export function dayShares(day: SeriesDay): { slot: Slot; share: number }[] {
  const positive = SLOTS.map((slot) => ({ slot, amount: day.classes[slot] ?? 0 })).filter((x) => x.amount > 0 && isMoney(x.amount));
  const total = positive.reduce((s, x) => s + x.amount, 0);
  return total > 0 ? positive.map((x) => ({ slot: x.slot, share: x.amount / total })) : [];
}

/** "61% US stocks, 24% international stocks, 15% bonds": a day's mix, the
 *  largest first. */
export function dayMixText(day: SeriesDay): string {
  const totals = Object.fromEntries(SLOTS.map((s) => [s, day.classes[s] ?? 0])) as Record<Slot, number>;
  const rows = shares(totals, SLOTS);
  if (rows.length === 0 || rows.some((r) => r.pct === null)) return 'nothing held to show as shares';
  return [...rows]
    .sort((a, b) => b.amount - a.amount)
    .map((r) => `${r.label} ${CLASS_WORDS[r.slot]}`)
    .join(', ');
}

/**
 * The mix on each recorded day, as a column of the classes' shares, on a
 * calendar axis from the first recorded day to the last, so a day nothing
 * was recorded on is a gap and nothing is drawn before the first. A day
 * missing an account is drawn faint, with a mark under it. A readout above
 * the plot names the day being read (the last, until another is touched) and
 * what it leaves out, and a table of the same figures sits behind "Show as a
 * table".
 */
export function AllocationHistoryChart({
  days,
  currency,
  answer,
  nameOf,
}: {
  days: SeriesDay[];
  currency: string | null;
  answer: Pick<HistoryAnswer, 'accounts'>;
  nameOf: (id: string) => string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  if (days.length === 0) return null;
  const first = dayNum(days[0].date);
  const span = dayNum(days[days.length - 1].date) - first + 1;
  const plotW = W - PAD_LEFT - PAD_RIGHT;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const slot = plotW / span;
  // Columns at most 24px, a 2px gap between neighbours while there is room
  // for one; past that the days touch, and read as an area.
  const width = slot >= 4 ? Math.min(24, slot - 2) : slot;
  const xs = days.map((d) => PAD_LEFT + (dayNum(d.date) - first) * slot + (slot - width) / 2);
  const i = active ?? days.length - 1;
  const day = days[i];
  const negative = days.some((d) => Object.values(d.classes).some((v) => (v ?? 0) < 0 && isMoney(v ?? 0)));
  const present = SLOTS.filter((s) => days.some((d) => (d.classes[s] ?? 0) > 0 && isMoney(d.classes[s] ?? 0)));

  function scrub(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let k = 1; k < xs.length; k++) if (Math.abs(xs[k] + width / 2 - px) < Math.abs(xs[best] + width / 2 - px)) best = k;
    setActive(best);
  }

  return (
    <div>
      <div className="chart-readout chart-readout-stable alloc-readout">
        <span className="chart-readout-value">{dayMixText(day)}</span>
        <span className="chart-readout-date">
          {dayName(day.date)} · {wholeMoney(day.total, currency)} counted
          {day.missing.length ? ` · leaves out ${missingOn(day, answer, nameOf)}` : ''}
        </span>
      </div>
      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Your mix on each of ${days.length} recorded days, from ${dayName(days[0].date)} to ${dayName(days[days.length - 1].date)}. On the last: ${dayMixText(days[days.length - 1])}${
          days[days.length - 1].missing.length ? `, leaving out ${missingOn(days[days.length - 1], answer, nameOf)}` : ''
        }.`}
        onPointerMove={(e) => scrub(e.clientX)}
        onPointerDown={(e) => scrub(e.clientX)}
        onPointerLeave={() => setActive(null)}
      >
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={PAD_TOP + (1 - t) * plotH} y2={PAD_TOP + (1 - t) * plotH} stroke="#262a33" strokeWidth={1} />
            <text className="chart-tick" x={PAD_LEFT - 6} y={PAD_TOP + (1 - t) * plotH} textAnchor="end" dominantBaseline="middle">
              {t * 100}%
            </text>
          </g>
        ))}
        {days.map((d, k) => {
          let y = PAD_TOP + plotH;
          const faint = d.missing.length > 0;
          return (
            <g key={d.date} opacity={faint ? 0.45 : 1}>
              {dayShares(d).map(({ slot: s, share }) => {
                const h = share * plotH;
                y -= h;
                // A 2px surface gap between segments, where one is tall
                // enough to keep a mark after it.
                const gap = h > 4 ? 2 : 0;
                return <rect key={s} x={xs[k]} y={y + gap / 2} width={Math.max(width, 0.6)} height={Math.max(h - gap, 0.5)} fill={CLASS_COLORS[s]} />;
              })}
              {faint && <circle cx={xs[k] + width / 2} cy={PAD_TOP + plotH + 6} r={2.5} fill="var(--warn)" />}
            </g>
          );
        })}
        {active !== null && <rect x={xs[i] - 1} y={PAD_TOP - 2} width={width + 2} height={plotH + 4} fill="none" stroke="#8b8f98" strokeWidth={1} />}
        <text className="chart-xlabel" x={PAD_LEFT} y={H - 4} textAnchor="start">
          {dayName(days[0].date)}
        </text>
        {days.length > 1 && (
          <text className="chart-xlabel" x={W - PAD_RIGHT} y={H - 4} textAnchor="end">
            {dayName(days[days.length - 1].date)}
          </text>
        )}
      </svg>
      <div className="chart-legend">
        {present.map((s) => (
          <span key={s} className="chart-legend-item">
            <span className="alloc-swatch" style={{ background: CLASS_COLORS[s] }} aria-hidden="true" />
            {CLASS_NAMES[s]}
          </span>
        ))}
        {days.some((d) => d.missing.length > 0) && (
          <span className="chart-legend-item">
            <span className="alloc-missing-dot" aria-hidden="true" />
            Missing an account
          </span>
        )}
      </div>
      {negative && <p className="panel-note">Money owed on a day (cash borrowed on margin, say) isn&apos;t drawn: the columns are shares of what was held. The table has every figure.</p>}
      <details className="plan-table-view">
        <summary>Show as a table</summary>
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Mix</th>
              <th className="num">Counted</th>
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map((d) => (
              <tr key={d.date}>
                <td>{dayName(d.date)}</td>
                <td>
                  {dayMixText(d)}
                  {d.missing.length > 0 && <div className="alloc-sub">Leaves out {missingOn(d, answer, nameOf)}</div>}
                </td>
                <td className="num">{compactMoney(d.total, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** For the simulation's form: the mix it can fill in, when the allocation
 *  has one and the person's settings are in it. */
export function mixToOffer(a: AllocationState): (PlanMix & { ok: true }) | null {
  return a.withSettings && a.mix.ok ? a.mix : null;
}

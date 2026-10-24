'use client';

// One institution's card on the Accounts tab: its header and subtotal, its
// account rows, and the notices about its connection. Moved from
// components/Dashboard.tsx so a test can render it (rollout phase 3).

import { Fragment } from 'react';
import AccountSparkline from './AccountSparkline';
import HoldingsRecorded from './HoldingsRecorded';
import InvestmentActivity from './InvestmentActivity';
import { ReconnectSoonNote } from './ConnectionHealth';
import { AccountQuestions, type useAccountLifecycle } from './AccountLifecycle';
import { Masked } from './HideAmounts';
import { institutionNote } from './currency-text';
import type { ImportTarget } from './ImportSheet';
import type { HistoryImportTarget } from './HistoryImportSheet';
import { connectorBalanceDay, connectorLabel } from '@/lib/connectors/types';
import { balancesNow, needsConverting } from '@/lib/fx/view';
import type { NetWorthBase } from '@/lib/fx/net-worth-base';
import { dominantCurrency, hiddenFigure } from '@/lib/format';
import { isInvestmentType, isOwedType } from '@/lib/balance';
import { institutionCash, isCashHolding, cashSharePct } from '@/lib/cash';
import {
  canEnableLiabilities,
  fmt,
  fmtAsOf,
  fmtDay,
  fmtGain,
  fmtInstantDay,
  fmtStaleDay,
  liabilitySummary,
  signedBalance,
  type AccountLiability,
  type Institution,
  type ManualAccount,
} from './accounts-format';

/**
 * The rest of a liability's terms, shown only when the row is expanded (the
 * collapsed row already carries rate, minimum and due date).
 *
 * Follows TxnDetail in MonthBreakdown: push only fields that are present, and
 * render nothing rather than a list of dashes when none are.
 */
export function LiabilityDetail({
  liability,
  currency,
}: {
  liability?: AccountLiability;
  currency: string | null;
}) {
  if (!liability) return null;
  const l = liability;
  const rows: { label: string; value: string }[] = [];

  if (l.apr != null && l.apr_label) rows.push({ label: l.apr_label, value: `${l.apr.toFixed(2)}%` });
  if (l.last_statement_balance != null) {
    rows.push({ label: 'Statement balance', value: fmt(l.last_statement_balance, currency) });
  }
  if (l.last_payment_amount != null) {
    rows.push({
      label: 'Last payment',
      value:
        fmt(l.last_payment_amount, currency) +
        (l.last_payment_date ? ` on ${fmtDay(l.last_payment_date)}` : ''),
    });
  }
  if (l.outstanding_interest != null) {
    rows.push({ label: 'Accrued interest', value: fmt(l.outstanding_interest, currency) });
  }
  if (l.escrow_balance != null) {
    rows.push({ label: 'Escrow', value: fmt(l.escrow_balance, currency) });
  }
  if (l.expected_payoff_date) {
    rows.push({ label: 'Expected payoff', value: fmtDay(l.expected_payoff_date) });
  }
  if (l.maturity_date) rows.push({ label: 'Matures', value: fmtDay(l.maturity_date) });

  if (rows.length === 0) return null;
  return (
    <dl className="txn-detail">
      {rows.map((r) => (
        <div className="txn-detail-row" key={r.label}>
          <dt>{r.label}</dt>
          <dd>
            <Masked>{r.value}</Masked>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export type InstitutionCardProps = {
  inst: Institution;
  /** Every institution as loaded, hidden accounts included, for the questions about them. */
  institutions: Institution[];
  base: NetWorthBase | null;
  shownCurrency: string | null;
  connecting: boolean;
  savingManual: boolean;
  togglingHidden: string | null;
  expandedAccounts: Set<string>;
  expandedHoldings: Set<string>;
  unallowedIds: Set<string>;
  lifecycle: Pick<ReturnType<typeof useAccountLifecycle>, 'busy' | 'open' | 'stillOpen' | 'confirmEnd' | 'reopen'>;
  txnEdits: { openAdd: (account_id: string) => void };
  toggleAccount: (account_id: string) => void;
  toggleHoldings: (item_id: string) => void;
  toggleHidden: (account_id: string, hidden: boolean) => void;
  setOptionsTarget: (inst: Institution) => void;
  startEditManual: (account: ManualAccount) => void;
  setImportTarget: (target: ImportTarget) => void;
  setHistoryTarget: (target: HistoryImportTarget) => void;
  setManualError: (message: string) => void;
  setManualDeleteTarget: (account: ManualAccount) => void;
  startReconnect: (item_id: string) => void;
  startAllowTransactions: (item_id: string) => void;
  startEnableLiabilities: (item_id: string) => void;
  startManageAccounts: (item_id: string) => void;
};

export default function InstitutionCard({
  inst,
  institutions,
  base,
  shownCurrency,
  connecting,
  savingManual,
  togglingHidden,
  expandedAccounts,
  expandedHoldings,
  unallowedIds,
  lifecycle,
  txnEdits,
  toggleAccount,
  toggleHoldings,
  toggleHidden,
  setOptionsTarget,
  startEditManual,
  setImportTarget,
  setHistoryTarget,
  setManualError,
  setManualDeleteTarget,
  startReconnect,
  startAllowTransactions,
  startEnableLiabilities,
  startManageAccounts,
}: InstitutionCardProps) {
  // One verdict for the row badge, the per-holding chip and the
  // Holdings header, so they can't disagree about the same money.
  // `inst` is already filtered, so a hidden brokerage takes its
  // cash with it.
  const instCash = institutionCash(inst.accounts, inst.holdings);
  const instTotal = inst.accounts.reduce((sum, a) => sum + signedBalance(a), 0);
  const instCurrency = dominantCurrency(
    inst.accounts.map((a) => ({ iso_currency_code: a.currency }))
  );
  const instMixed =
    new Set(inst.accounts.map((a) => a.currency).filter(Boolean)).size > 1;
  // Mixed, with a home currency chosen: converted into it, at
  // the newest rates, as the hero is (lib/fx/view.ts).
  const instRows = inst.accounts.map((a) => ({ amount: signedBalance(a), currency: a.currency }));
  const instConverted = instMixed && base && needsConverting(instRows, base.fx, instCurrency) ? balancesNow(instRows, base.fx, instCurrency) : null;
  // Every row, hidden ones too, for the questions about them
  // (#50), and whether each one held was answered Still open.
  const allRows = institutions.find((i) => i.item_id === inst.item_id)?.accounts ?? inst.accounts;
  const heldRows = allRows.filter((a) => a.held);
  const heldStillOpen = heldRows.length > 0 && heldRows.every((a) => a.question?.still_open);
  return (
    <div className="card" key={inst.item_id}>
      <div className="inst-header">
        <div className="inst-name">
          {inst.institution_name}
          {inst.manual && <span className="manual-badge">{inst.connector ? `via ${inst.health?.detail?.label ?? connectorLabel(inst.connector)}` : 'Manual'}</span>}
        </div>
        <div className="inst-header-right">
          <div className="inst-total">
            <Masked>{fmt(instConverted ? instConverted.total : instTotal, instConverted ? instConverted.currency : instCurrency)}</Masked>
          </div>
          {/* Add or remove accounts and Disconnect. Manual
              groupings aren't Plaid Items, so there's nothing
              to disconnect; they're removed per account. */}
          {!inst.manual && (
            <button
              className="secondary inst-options"
              onClick={() => setOptionsTarget(inst)}
              aria-label={`Options for ${inst.institution_name}`}
            >
              Options
            </button>
          )}
        </div>
      </div>

      {instMixed && (
        <div className="chart-note">
          {instConverted ? institutionNote(instConverted) : <>Mixed currencies; total isn&apos;t converted.</>}
        </div>
      )}

      {inst.accounts.length > 0 && (
        <table>
          <tbody>
            {inst.accounts.map((a) => {
              const util =
                a.type === 'credit' && a.limit && a.limit > 0 && a.balance != null
                  ? Math.max(a.balance, 0) / a.limit
                  : null;
              const liabLine = liabilitySummary(a);
              // Undefined on an account that is cash by design:
              // institutionCash drops those, since 100% cash in a
              // cash management account is the account working.
              const cash = instCash.byAccount[a.account_id];
              return (
                <Fragment key={a.account_id}>
                <tr
                  className="acct-row"
                  onClick={() => toggleAccount(a.account_id)}
                  aria-expanded={expandedAccounts.has(a.account_id)}
                >
                  <td>
                    {a.name}
                    {a.mask && <span className="acct-mask"> ••{a.mask}</span>}
                    <div className="type-tag">
                      {a.official_name && a.official_name !== a.name
                        ? `${a.official_name} · `
                        : ''}
                      {a.subtype || a.type}
                      {/* The currency chosen for a typed
                          balance, when not the one shown. */}
                      {inst.manual && !inst.connector && a.currency && a.currency !== shownCurrency ? ` · in ${a.currency}` : ''}
                    </div>
                    {/* A Plaid balance is implicitly "now"; a
                        typed one has to say when it was set. */}
                    {inst.manual && a.updated_at && (
                      <div className="manual-updated">
                        {/* SimpleFIN's balance is as of the day the bank gave it; Lunch Flow gives no day, so its is the day Nya received it. */}
                        {inst.connector ? connectorBalanceDay(inst.connector, fmtInstantDay(a.updated_at)) : `Updated ${fmtAsOf(a.updated_at)}`}
                      </div>
                    )}
                    {/* Missing from its bank's answer, held
                        until the question below is answered
                        (#50): said, not passed off as now. */}
                    {a.held && (
                      <div className="manual-updated">
                        {a.held.as_of
                          ? `Last known balance, from ${fmtDay(a.held.as_of)}`
                          : 'No recent balance, so not counted'}
                      </div>
                    )}
                    {util != null && (
                      <div className="util">
                        <div className={`meter-track${util >= 0.9 ? ' over' : util >= 0.5 ? ' warn' : ''}`}>
                          <div
                            className={`meter-fill${util >= 0.9 ? ' over' : util >= 0.5 ? ' warn' : ''}`}
                            style={{ width: `${Math.min(util * 100, 100)}%` }}
                          />
                        </div>
                        <span className="util-label">
                          {Math.round(util * 100)}% of <Masked>{fmt(a.limit, a.currency)}</Masked> limit
                        </span>
                      </div>
                    )}
                    {liabLine && (
                      <div
                        className={`type-tag${a.liability?.is_overdue ? ' over-tag' : ''}`}
                      >
                        {a.liability?.is_overdue ? 'Overdue · ' : ''}
                        <Masked>{liabLine}</Masked>
                      </div>
                    )}
                    {/* Money sitting in the settlement fund
                        rather than invested. Always shown when
                        there is any, because a small cash line
                        is information; the amber treatment is
                        reserved for an amount worth acting on
                        (lib/cash.ts), so the colour keeps
                        meaning something. */}
                    {cash && cash.cash > 0 && (
                      <div className={`cash-tag${cash.flagged ? ' idle' : ''}`}>
                        {cash.flagged && (
                          <span className="cash-dot" aria-hidden="true" />
                        )}
                        <Masked>{fmt(cash.cash, a.currency)}</Masked>
                        {cash.flagged ? ' uninvested' : ' in cash'}
                        {/* "of holdings", not "of this
                            account": the denominator is the
                            positions Plaid priced, which can
                            fall short of the balance rendered
                            in the next column. */}
                        {/* Says whose share it is: "0.0% of
                            holdings" alone read as "0%
                            invested", the opposite of what it
                            meant. And never 0.0% while there
                            is cash to show. */}
                        {cash.total > 0 && ` · cash is ${cashSharePct(cash.share)} of holdings`}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    <Masked>{a.held && a.balance == null ? '--' : fmt(signedBalance(a), a.currency)}</Masked>
                    {inst.manual && !inst.connector && (
                      // stopPropagation so tapping an action
                      // doesn't also toggle the history chart.
                      <div
                        className="manual-row-actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {inst.manual && !inst.connector && (
                          <button
                            className="link-btn"
                            disabled={savingManual || togglingHidden !== null}
                            onClick={() =>
                              startEditManual({
                                account_id: a.account_id,
                                name: a.name,
                                institution_name: inst.institution_name,
                                type: a.type,
                                subtype: a.subtype,
                                balance: a.balance ?? 0,
                                currency: a.currency ?? undefined,
                              })
                            }
                          >
                            Update
                          </button>
                        )}
                        {inst.manual && !inst.connector && (
                          <button className="link-btn" onClick={() => txnEdits.openAdd(a.account_id)}>
                            Add transaction
                          </button>
                        )}
                        {inst.manual && !inst.connector && !a.hidden && (
                          <button className="link-btn" onClick={() => setImportTarget({ account_id: a.account_id })}>
                            Import
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
                {expandedAccounts.has(a.account_id) && (
                  <tr>
                    <td colSpan={2} className="acct-chart-cell">
                      {/* Hide, Close… and Delete, in the
                          expanded row rather than the
                          clickable one (a manual account's
                          Update, Add transaction and Import
                          stay on its row until the account
                          sheet, rollout phase 3). */}
                      <div className="card-actions acct-actions">
                        {/* Hiding works on any account, linked
                            or manual: it only stops the account
                            counting, it doesn't remove it. Not
                            on a row held for an answer: its
                            bank isn't returning it, so there is
                            nothing to hide yet (#50). */}
                        {!a.held && (
                          <button
                            className="secondary"
                            disabled={togglingHidden !== null}
                            onClick={() => toggleHidden(a.account_id, true)}
                          >
                            {togglingHidden === a.account_id ? 'Hiding…' : 'Hide'}
                          </button>
                        )}
                        {/* Closed, no longer theirs, or not
                            tracked from a day (#50): unlike
                            Hide, every day before it counts. */}
                        <button
                          className="secondary"
                          disabled={lifecycle.busy}
                          aria-label={`${a.name}: closed, no longer yours, or stop following`}
                          onClick={() =>
                            lifecycle.open({
                              account_id: a.account_id,
                              name: a.name,
                              mask: a.mask,
                              institution: inst.institution_name,
                              ...(a.question ? { day: a.question.end } : {}),
                              // What it shows, so the sheet
                              // can say what ending it does.
                              balance: a.balance,
                              type: a.type,
                              currency: a.currency,
                              lastKnown: !!a.held,
                            })
                          }
                        >
                          Close…
                        </button>
                        {inst.manual && !inst.connector && (
                          <button
                            className="danger-outline"
                            disabled={savingManual || togglingHidden !== null}
                            onClick={() => {
                              setManualError('');
                              setManualDeleteTarget({
                                account_id: a.account_id,
                                name: a.name,
                                institution_name: inst.institution_name,
                                type: a.type,
                                subtype: a.subtype,
                                balance: a.balance ?? 0,
                              });
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                      <AccountSparkline
                        accountId={a.account_id}
                        currency={a.currency}
                        investment={isInvestmentType(a.type)}
                        owed={isOwedType(a.type)}
                        itemId={
                          isInvestmentType(a.type) && !inst.manual
                            ? inst.item_id
                            : undefined
                        }
                      />
                      {/* Since when its positions have been
                          kept (lib/holdings-history.ts). A
                          manual account has none to keep. */}
                      {isInvestmentType(a.type) && !inst.manual && (
                        <HoldingsRecorded accountId={a.account_id} />
                      )}
                      <LiabilityDetail liability={a.liability} currency={a.currency} />
                      {/* Not for manual accounts: they're typed
                          by hand, and their synthetic
                          `manual:<name>` item_id doesn't
                          resolve to a Plaid Item, so the fetch
                          would 404 into a red error box under a
                          perfectly healthy row. */}
                      {isInvestmentType(a.type) && !inst.manual && (
                        <InvestmentActivity
                          accountId={a.account_id}
                          itemId={inst.item_id}
                        />
                      )}
                      {/* Years of a linked account's history
                          from its bank's own files (#52). */}
                      {!inst.manual && (
                        <button
                          className="link-btn history-import-link"
                          onClick={() =>
                            setHistoryTarget({
                              account_id: a.account_id,
                              name: a.name,
                              institution_name: inst.institution_name,
                              type: a.type,
                              currency: a.currency ?? null,
                            })
                          }
                        >
                          Import history from a file
                        </button>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      {inst.holdings.length > 0 && (
        <>
          <button
            className="holdings-toggle"
            onClick={() => toggleHoldings(inst.item_id)}
            aria-expanded={expandedHoldings.has(inst.item_id)}
          >
            <span className="holdings-title">
              Holdings
              <span className="holdings-count">{inst.holdings.length}</span>
            </span>
            <span className="holdings-summary">
              {/* Says "uninvested", not "cash", because it is
                  scoped the way the amber is: an account that
                  is cash by design is left out of this figure,
                  while its positions still carry their factual
                  Cash label in the list below. */}
              {instCash.cash > 0 && (
                <span className={`cash-chip${instCash.flagged ? ' idle' : ''}`}>
                  <Masked>{fmt(instCash.cash, instCurrency)}</Masked>{' '}
                  {instCash.flagged ? 'uninvested' : 'cash'}
                </span>
              )}
              <Masked>{fmt(inst.holdings.reduce((sum, h) => sum + (h.value ?? 0), 0), instCurrency)}</Masked>
              <svg
                className={`chevron${expandedHoldings.has(inst.item_id) ? ' open' : ''}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </button>
          {expandedHoldings.has(inst.item_id) && (
          <table>
            <thead>
              <tr>
                <th>Security</th>
                <th className="num">Qty</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {inst.holdings.map((h, i) => {
                const isCash = isCashHolding(h);
                return (
                <tr key={i}>
                  <td>
                    {h.name}
                    {/* The chip says WHICH row is cash; the
                        amber says it's worth doing something
                        about, and only the owning account can
                        decide that. */}
                    {isCash && (
                      <span
                        className={`cash-chip${
                          h.account_id && instCash.flaggedAccounts.has(h.account_id)
                            ? ' idle'
                            : ''
                        }`}
                      >
                        Cash
                      </span>
                    )}
                  </td>
                  <td className="num"><Masked>{h.quantity != null ? hiddenFigure(h.quantity.toFixed(3)) : '--'}</Masked></td>
                  <td className="num">
                    <Masked>{fmt(h.value)}</Masked>
                    {/* No gain/loss on a cash line: a money
                        market fund holds its $1 NAV, so the
                        figure is a permanent "+$0.00 · 0.0%"
                        that says nothing and reads as a real
                        measurement of a flat investment. */}
                    {!isCash && h.value != null && h.cost_basis != null && (
                      <div
                        className={`gain${h.value - h.cost_basis >= 0 ? ' inflow' : ' loss'}`}
                      >
                        <Masked>{fmtGain(h.value, h.cost_basis)}</Masked>
                      </div>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </>
      )}

      {/* Plaid's week of notice that this connection will end:
          the badge, the date and Reconnect, while it still works. */}
      <ReconnectSoonNote inst={inst} connecting={connecting} onReconnect={startReconnect} />

      {/* Recovering the balances adds a date to the error; it
          does not replace the error. The distinction matters:
          "could not fetch balances" usually clears itself,
          while "needs to be reconnected" never does until you
          act, and collapsing both into a soft "couldn't
          refresh" would let a dead connection look healthy for
          as long as the recovered numbers stay plausible --
          the same failure this feature exists to prevent, moved
          from the total to the label. So reauth keeps the red
          treatment and its own wording, and only a transient
          failure with real numbers behind it goes amber. */}
      {inst.error && (
        <div
          className={
            // Amber is for "real numbers, just dated". A card
            // missing rows isn't that: its subtotal is wrong,
            // not merely old, so it keeps the red treatment.
            inst.stale_as_of && !inst.needs_reauth && !inst.stale_missing
              ? 'stale-note'
              : 'error'
          }
        >
          {inst.error}
          {inst.stale_as_of && ` · balances as of ${fmtStaleDay(inst.stale_as_of, inst.stale_as_of_at)}`}
          {/* The shortfall is disclosed, not hidden: a card
              drawn short understates debt, which overstates
              net worth. Why a row is missing is unknowable
              here (see lib/last-known.ts), so say the count
              rather than guess at a reason. */}
          {!!inst.stale_missing &&
            ` · ${inst.stale_missing} account${
              inst.stale_missing === 1 ? '' : 's'
            } couldn't be shown, so this total is incomplete`}
          {inst.stale_too_old &&
            ` · last known balances are from ${fmtStaleDay(inst.stale_too_old, inst.stale_too_old_at)}, too old to show`}
        </div>
      )}

      {/* Its own block, NOT part of the error above, because
          there is no error: this institution answered and the
          balances on the card are fresh. It just answered with
          fewer accounts than it used to have, so the subtotal
          is short and nothing is being written to history
          until that resolves.

          Amber rather than red for the same reason the stale
          case is: the numbers shown are real. What is wrong is
          that there are not all of them. */}
      {!!inst.unconfirmed_missing && !inst.error && (
        <div className="stale-note">
          {inst.unconfirmed_missing} account
          {inst.unconfirmed_missing === 1 ? '' : 's'} this institution used to
          report {inst.unconfirmed_missing === 1 ? "isn't" : "aren't"} in its latest
          response · {inst.unconfirmed_missing === 1 ? 'it is' : 'they are'} held at{' '}
          {inst.unconfirmed_missing === 1 ? 'its' : 'their'} last known balance
          {/* Answered Still open: held for the account, two weeks at most. */}
          {heldStillOpen
            ? ` until ${inst.unconfirmed_missing === 1 ? 'it comes' : 'they come'} back, two weeks from your answer at most, and history is paused until then`
            : ` until you say whether ${inst.unconfirmed_missing === 1 ? 'it' : 'they'} closed, and history is paused until then`}
        </div>
      )}

      {/* The questions about its accounts (#50): missing
          from its answer, at zero for weeks, or ended and
          still reported. From every row, a hidden one's too:
          its absence holds every total all the same. */}
      <AccountQuestions
        accounts={[...allRows, ...(inst.ended_reported ?? [])]}
        institution={inst.institution_name}
        busy={lifecycle.busy}
        onOpen={lifecycle.open}
        onStillOpen={lifecycle.stillOpen}
        onConfirmEnd={lifecycle.confirmEnd}
        onReopen={lifecycle.reopen}
      />

      {/* Tells someone who just tapped Enable why the button
          vanished without any payment details appearing. */}
      {inst.liabilities === 'loading' && (
        <p className="empty-note">
          Payment details are still importing from this institution.
        </p>
      )}

      {inst.new_accounts_available && !inst.manual && (
        <p className="empty-note">
          {inst.institution_name} has accounts you haven&apos;t added yet.
        </p>
      )}

      {unallowedIds.has(inst.item_id) && (
        <p className="empty-note">
          You didn&apos;t allow Nya to see transactions from the bank or card accounts here.
        </p>
      )}

      {/* One container, independent actions. Enable must NOT
          sit inside a needs_reauth gate: a healthy institution
          is exactly the case it exists for. */}
      {(inst.needs_reauth ||
        canEnableLiabilities(inst) ||
        unallowedIds.has(inst.item_id) ||
        (!inst.manual && inst.new_accounts_available)) && (
        <div className="card-actions">
          {inst.needs_reauth && (
            <button onClick={() => startReconnect(inst.item_id)} disabled={connecting} aria-label={`Reconnect ${inst.institution_name}`}>
              Reconnect
            </button>
          )}
          {unallowedIds.has(inst.item_id) && (
            <button
              className="secondary"
              onClick={() => startAllowTransactions(inst.item_id)}
              disabled={connecting}
              aria-label={`Allow transactions from ${inst.institution_name}`}
            >
              Allow transactions
            </button>
          )}
          {canEnableLiabilities(inst) && (
            <button
              className="secondary"
              onClick={() => startEnableLiabilities(inst.item_id)}
              disabled={connecting}
            >
              Enable payment details
            </button>
          )}
          {/* Adds accounts to THIS Item rather than connecting
              the institution again (a second, separately
              billed Item). Here whenever Plaid has found new
              accounts; always under Options. */}
          {!inst.manual && inst.new_accounts_available && (
            <button
              className="secondary"
              onClick={() => startManageAccounts(inst.item_id)}
              disabled={connecting}
            >
              Review accounts
            </button>
          )}
        </div>
      )}
    </div>
  );
}

'use client';

// One account's sheet, opened by its row on the Accounts tab
// (docs/design/information-architecture.md#accounts): its balance and where
// it comes from, its history, holdings and payment terms, and every action on
// it. Hide and Close... are in the footer, with Update balance and Add
// transaction on a typed account; the rare ones are in its ⋯. Replaces the
// row that expanded in place and the buttons that sat inside it.
//
// Each action closes this sheet first and opens its own, as the rest of the
// dashboard does, so no sheet opens on top of another.

import AccountSparkline from './AccountSparkline';
import HoldingsRecorded from './HoldingsRecorded';
import InvestmentActivity from './InvestmentActivity';
import { Sheet } from './Sheet';
import { Menu, type MenuItem } from './Menu';
import { Masked } from './HideAmounts';
import type { LifecycleTarget } from './AccountLifecycle';
import type { HistoryImportTarget } from './HistoryImportSheet';
import { hiddenFigure } from '@/lib/format';
import { isInvestmentType, isOwedType } from '@/lib/balance';
import { institutionCash, isCashHolding, cashSharePct } from '@/lib/cash';
import {
  accountKind,
  balanceDay,
  fmt,
  fmtDay,
  fmtGain,
  heldLine,
  liabilitySummary,
  signedBalance,
  type Account,
  type AccountLiability,
  type Holding,
  type Institution,
  type ManualAccount,
} from './accounts-format';

/**
 * The rest of a liability's terms (its row already carries rate, minimum and
 * due date).
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

/** Positions with their value, and gain or loss against cost. `flagged` is
 *  the accounts whose cash is worth acting on (lib/cash.ts). */
export function HoldingsTable({ holdings, flagged }: { holdings: Holding[]; flagged: Set<string> }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Security</th>
          <th className="num">Qty</th>
          <th className="num">Value</th>
        </tr>
      </thead>
      <tbody>
        {holdings.map((h, i) => {
          const isCash = isCashHolding(h);
          return (
            <tr key={i}>
              <td>
                {h.name}
                {/* The chip says WHICH row is cash; the amber says it's
                    worth doing something about, and only the owning
                    account can decide that. */}
                {isCash && <span className={`cash-chip${h.account_id && flagged.has(h.account_id) ? ' idle' : ''}`}>Cash</span>}
              </td>
              <td className="num">
                <Masked>{h.quantity != null ? hiddenFigure(h.quantity.toFixed(3)) : '--'}</Masked>
              </td>
              <td className="num">
                <Masked>{fmt(h.value)}</Masked>
                {/* No gain/loss on a cash line: a money market fund holds
                    its $1 NAV, so the figure is a permanent "+$0.00 · 0.0%"
                    that says nothing and reads as a real measurement of a
                    flat investment. */}
                {!isCash && h.value != null && h.cost_basis != null && (
                  <div className={`gain${h.value - h.cost_basis >= 0 ? ' inflow' : ' loss'}`}>
                    <Masked>{fmtGain(h.value, h.cost_basis)}</Masked>
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export type AccountSheetProps = {
  open: boolean;
  /** The account and its institution as shown on the tab (hidden ones left out). */
  account: Account | null;
  inst: Institution | null;
  shownCurrency: string | null;
  /** A manual account is being saved, or an account hidden or unhidden. */
  saving: boolean;
  hiding: boolean;
  lifecycleBusy: boolean;
  onDismiss: () => void;
  onHide: (account_id: string) => void;
  onEnd: (target: LifecycleTarget) => void;
  onUpdate: (account: ManualAccount) => void;
  onAddTransaction: (account_id: string) => void;
  onImport: (account_id: string) => void;
  onImportHistory: (target: HistoryImportTarget) => void;
  onDelete: (account: ManualAccount) => void;
};

export default function AccountSheet({
  open,
  account: a,
  inst,
  shownCurrency,
  saving,
  hiding,
  lifecycleBusy,
  onDismiss,
  onHide,
  onEnd,
  onUpdate,
  onAddTransaction,
  onImport,
  onImportHistory,
  onDelete,
}: AccountSheetProps) {
  if (!a || !inst) return null;
  const act = (go: () => void) => () => {
    onDismiss();
    go();
  };
  // A typed account, not one SimpleFIN or Lunch Flow feeds.
  const typed = !!inst.manual && !inst.connector;
  const manual: ManualAccount = {
    account_id: a.account_id,
    name: a.name,
    institution_name: inst.institution_name,
    type: a.type,
    subtype: a.subtype,
    balance: a.balance ?? 0,
    currency: a.currency ?? undefined,
  };

  const cashOf = institutionCash(inst.accounts, inst.holdings);
  const cash = cashOf.byAccount[a.account_id];
  const holdings = inst.holdings.filter((h) => h.account_id === a.account_id);
  const util = a.type === 'credit' && a.limit && a.limit > 0 && a.balance != null ? Math.max(a.balance, 0) / a.limit : null;
  const liabLine = liabilitySummary(a);
  const held = heldLine(a);
  const day = held ? null : balanceDay(a, inst);

  const more: MenuItem[] = [
    ...(typed && !a.hidden ? [{ label: 'Import a file', onSelect: act(() => onImport(a.account_id)) }] : []),
    // Years of a linked account's history from its bank's own files (#52).
    ...(!inst.manual
      ? [
          {
            label: 'Import history from a file',
            onSelect: act(() =>
              onImportHistory({ account_id: a.account_id, name: a.name, institution_name: inst.institution_name, type: a.type, currency: a.currency ?? null })
            ),
          },
        ]
      : []),
    ...(typed ? [{ label: 'Delete…', danger: true, disabled: saving || hiding, onSelect: act(() => onDelete(manual)) }] : []),
  ];

  const footer = (
    <>
      {/* Hiding only stops it counting. Not on a row held for an answer:
          its bank isn't returning it, so there is nothing to hide yet (#50). */}
      {!a.held && (
        <button className="btn secondary" disabled={hiding} onClick={act(() => onHide(a.account_id))}>
          Hide
        </button>
      )}
      {/* Closed, no longer theirs, or not tracked from a day (#50): unlike
          Hide, every day before it counts. */}
      <button
        className="btn secondary"
        disabled={lifecycleBusy}
        aria-label={`${a.name}: closed, no longer yours, or stop following`}
        onClick={act(() =>
          onEnd({
            account_id: a.account_id,
            name: a.name,
            mask: a.mask,
            institution: inst.institution_name,
            ...(a.question ? { day: a.question.end } : {}),
            // What it shows, so the sheet can say what ending it does.
            balance: a.balance,
            type: a.type,
            currency: a.currency,
            lastKnown: !!a.held,
          })
        )}
      >
        Close…
      </button>
      {typed && (
        <button className="btn secondary" onClick={act(() => onAddTransaction(a.account_id))}>
          Add transaction
        </button>
      )}
      {typed && (
        <button className="btn" disabled={saving || hiding} onClick={act(() => onUpdate(manual))}>
          Update balance
        </button>
      )}
      {more.length > 0 && <Menu label={`More for ${a.name}`} items={more} />}
    </>
  );

  return (
    <Sheet open={open} title={`${a.name}${a.mask ? ` ••${a.mask}` : ''}`} onClose={onDismiss} footer={footer}>
      <div className="stack">
        <div className="account-hero">
          <p className="account-balance money">
            <Masked>{a.held && a.balance == null ? '--' : fmt(signedBalance(a), a.currency)}</Masked>
          </p>
          <p className="helper">
            {inst.institution_name} · {accountKind(a, inst, shownCurrency)}
            {day && ` · ${day}`}
          </p>
        </div>
        {held && (
          <p>
            <span className="badge warn">{held}</span>
          </p>
        )}
        {liabLine && (
          <p className="helper">
            {a.liability?.is_overdue && (
              <>
                <span className="badge neg">Overdue</span>
                {' · '}
              </>
            )}
            <Masked>{liabLine}</Masked>
          </p>
        )}
        {util != null && (
          <div className="util">
            <div className={`meter-track${util >= 0.9 ? ' over' : util >= 0.5 ? ' warn' : ''}`}>
              <div className={`meter-fill${util >= 0.9 ? ' over' : util >= 0.5 ? ' warn' : ''}`} style={{ width: `${Math.min(util * 100, 100)}%` }} />
            </div>
            <span className="util-label">
              {Math.round(util * 100)}% of <Masked>{fmt(a.limit, a.currency)}</Masked> limit
            </span>
          </div>
        )}
        {/* Always shown when there is any cash, because a small cash line is
            information; amber only for an amount worth acting on
            (lib/cash.ts). "of holdings", not "of this account": the
            denominator is the positions Plaid priced, which can fall short
            of the balance above. Never 0.0% while there is cash to show. */}
        {cash && cash.cash > 0 && (
          <p>
            <span className={`badge${cash.flagged ? ' warn' : ''}`}>
              <Masked>{fmt(cash.cash, a.currency)}</Masked>
              {cash.flagged ? ' uninvested' : ' in cash'}
              {cash.total > 0 && ` · cash is ${cashSharePct(cash.share)} of holdings`}
            </span>
          </p>
        )}
        <AccountSparkline
          accountId={a.account_id}
          currency={a.currency}
          investment={isInvestmentType(a.type)}
          owed={isOwedType(a.type)}
          itemId={isInvestmentType(a.type) && !inst.manual ? inst.item_id : undefined}
        />
        {/* Since when its positions have been kept (lib/holdings-history.ts).
            A manual account has none to keep. */}
        {isInvestmentType(a.type) && !inst.manual && <HoldingsRecorded accountId={a.account_id} />}
        {holdings.length > 0 && <HoldingsTable holdings={holdings} flagged={cashOf.flaggedAccounts} />}
        <LiabilityDetail liability={a.liability} currency={a.currency} />
        {/* Not for manual accounts: they're typed by hand, and their
            synthetic `manual:<name>` item_id doesn't resolve to a Plaid
            Item, so the fetch would 404 into a red error box under a
            perfectly healthy account. */}
        {isInvestmentType(a.type) && !inst.manual && <InvestmentActivity accountId={a.account_id} itemId={inst.item_id} />}
      </div>
    </Sheet>
  );
}

'use client';

// One institution's card on the Accounts tab: its header (name, where its
// balances come from, what is wrong, its subtotal and its ⋯), its account
// rows, and its connection's status (components/ConnectionStatus.tsx), which
// the Connection health card and the SimpleFIN and Lunch Flow cards used to
// show apart. Each row is one button that opens the account's sheet
// (components/AccountSheet.tsx): nothing inside a row is another control.

import { type useAccountLifecycle } from './AccountLifecycle';
import { Masked } from './HideAmounts';
import { Menu, type MenuItem } from './Menu';
import { institutionNote } from './currency-text';
import { HoldingsTable } from './AccountSheet';
import { ConnectionStatus, connectionSeverity, statusBadge, type ConnectionPlace } from './ConnectionStatus';
import type { ConnectorAsk } from './Connectors';
import { connectorLabel } from '@/lib/connectors/types';
import { balancesNow, needsConverting } from '@/lib/fx/view';
import type { NetWorthBase } from '@/lib/fx/net-worth-base';
import { dominantCurrency } from '@/lib/format';
import { institutionCash } from '@/lib/cash';
import {
  accountKind,
  balanceDay,
  canEnableLiabilities,
  fmt,
  heldLine,
  liabilitySummary,
  signedBalance,
  type Institution,
} from './accounts-format';

export const CHEVRON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

/** The id of an institution's card heading, which a jump to it focuses. */
export const cardHeadingId = (item_id: string) => `inst-${item_id}`;

export type InstitutionCardProps = {
  inst: Institution;
  /** Every institution as loaded, hidden accounts included, for the questions about them. */
  institutions: Institution[];
  base: NetWorthBase | null;
  shownCurrency: string | null;
  connecting: boolean;
  expandedHoldings: Set<string>;
  unallowedIds: Set<string>;
  lifecycle: Pick<ReturnType<typeof useAccountLifecycle>, 'busy' | 'open' | 'stillOpen' | 'confirmEnd' | 'reopen'>;
  /** A connector card's connection, and whether this card is its first. */
  place?: ConnectionPlace | null;
  /** Whether the day's requests to the connector are spent. */
  requestsLeft?: number | null;
  /** Opens the account's sheet. */
  onOpenAccount: (account_id: string) => void;
  toggleHoldings: (item_id: string) => void;
  /** Opens Connection details. */
  onDetails: (inst: Institution) => void;
  /** Disconnecting a Plaid connection (the typed-name sheet). */
  onRemove: (item_id: string) => void;
  onConnector: (ask: ConnectorAsk) => void;
  startReconnect: (item_id: string) => void;
  startAllowTransactions: (item_id: string) => void;
  startEnableLiabilities: (item_id: string) => void;
  startManageAccounts: (item_id: string) => void;
};

/** An institution's ⋯: its rare actions, Disconnect last. None on accounts
 *  typed by hand (each is removed in its own sheet) or on the card that
 *  says SimpleFIN's and Lunch Flow's accounts couldn't be read. */
export function institutionMenu(
  inst: Institution,
  place: ConnectionPlace | null,
  requestsLeft: number | null,
  on: Pick<InstitutionCardProps, 'onDetails' | 'onRemove' | 'onConnector' | 'startManageAccounts' | 'startEnableLiabilities'>
): MenuItem[] {
  const details = { label: 'Connection details', onSelect: () => on.onDetails(inst) };
  if (!inst.manual) {
    const h = inst.health;
    // Already a button on the card when Plaid found accounts or misses some.
    const managed = !!inst.new_accounts_available || (h?.action === 'resolve' && h.cause !== 'no_accounts');
    return [
      ...(h ? [details] : []),
      ...(managed ? [] : [{ label: 'Add or remove accounts', onSelect: () => on.startManageAccounts(inst.item_id) }]),
      ...(canEnableLiabilities(inst) ? [{ label: 'Enable payment details', onSelect: () => on.startEnableLiabilities(inst.item_id) }] : []),
      { label: 'Disconnect…', danger: true, onSelect: () => on.onRemove(inst.item_id) },
    ];
  }
  const conn = place?.conn;
  if (!inst.connector || !inst.connection_id || !conn) return [];
  const id = inst.connection_id;
  const issue = inst.health?.detail?.issue;
  // A connection that is gone can only be disconnected, which its card offers.
  if (issue === 'gone') return [details];
  return [
    details,
    { label: `Refresh ${conn.label}`, disabled: requestsLeft === 0, onSelect: () => on.onConnector({ kind: 'refresh', connection_id: id }) },
    ...(issue === 'missing' ? [] : [{ label: 'Choose accounts', onSelect: () => on.onConnector({ kind: 'accounts', connection_id: id }) }]),
    { label: `Disconnect ${conn.label}…`, danger: true, onSelect: () => on.onConnector({ kind: 'disconnect', connection_id: id }) },
  ];
}

export default function InstitutionCard({
  inst,
  institutions,
  base,
  shownCurrency,
  connecting,
  expandedHoldings,
  unallowedIds,
  lifecycle,
  place = null,
  requestsLeft = null,
  onOpenAccount,
  toggleHoldings,
  onDetails,
  onRemove,
  onConnector,
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
  const looseHoldings = inst.holdings.filter((h) => !h.account_id);
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
  // Every row, hidden ones too, for the questions about them (#50).
  const allRows = institutions.find((i) => i.item_id === inst.item_id)?.accounts ?? inst.accounts;
  const severity = connectionSeverity(inst, place);
  const badge = statusBadge(inst);
  const menu = institutionMenu(inst, place, requestsLeft, { onDetails, onRemove, onConnector, startManageAccounts, startEnableLiabilities });
  return (
    <section className="card stack">
      <div className="card-header">
        <h2 id={cardHeadingId(inst.item_id)} tabIndex={-1}>
          {inst.institution_name}
          {inst.manual && <> <span className="badge">{inst.connector ? `via ${inst.health?.detail?.label ?? connectorLabel(inst.connector)}` : 'Manual'}</span></>}
          {badge && severity && <> <span className={`badge ${severity === 'critical' ? 'neg' : 'warn'}`}>{badge}</span></>}
        </h2>
        <span className="money">
          <Masked>{fmt(instConverted ? instConverted.total : instTotal, instConverted ? instConverted.currency : instCurrency)}</Masked>
        </span>
        {menu.length > 0 && <Menu label={`Options for ${inst.institution_name}`} items={menu} />}
      </div>

      {instMixed && (
        <div className="chart-note">
          {instConverted ? institutionNote(instConverted) : <>Mixed currencies; total isn&apos;t converted.</>}
        </div>
      )}

      {/* Under the subtotal it qualifies, before the rows. */}
      <ConnectionStatus
        inst={inst}
        allRows={allRows}
        place={place}
        fx={base?.fx ?? null}
        connecting={connecting}
        unallowed={unallowedIds.has(inst.item_id)}
        lifecycle={lifecycle}
        onReconnect={startReconnect}
        onRemove={onRemove}
        onManageAccounts={startManageAccounts}
        onAllowTransactions={startAllowTransactions}
        onConnector={onConnector}
      />

      {inst.accounts.length > 0 && (
        <ul className="list-rows">
          {inst.accounts.map((a) => {
            const liabLine = liabilitySummary(a);
            // Undefined on an account that is cash by design:
            // institutionCash drops those, since 100% cash in a
            // cash management account is the account working.
            const cash = instCash.byAccount[a.account_id];
            // Missing from its bank's answer, held until the question
            // below is answered (#50): said, not passed off as now.
            const held = heldLine(a);
            // A Plaid balance is implicitly "now"; a typed or synced
            // one says when it was set.
            const day = held ? null : balanceDay(a, inst);
            // Its own fact, never waiting on the terms line, which can be
            // empty (no rate, minimum or date reported).
            const overdue = !!a.liability?.is_overdue;
            return (
              <li key={a.account_id}>
                <button className="list-row" onClick={() => onOpenAccount(a.account_id)}>
                  <span className="list-row-text">
                    <span className="list-row-title">
                      {a.name}
                      {a.mask && <span className="acct-mask"> ••{a.mask}</span>}
                    </span>
                    <span className="list-row-sub">
                      {overdue && (
                        <>
                          <span className="badge neg">Overdue</span>
                          {' · '}
                        </>
                      )}
                      {liabLine ? <Masked>{liabLine}</Masked> : accountKind(a, inst, shownCurrency)}
                      {/* Amber at its last known balance; red when not counted at all (lib/accounts-status.ts). */}
                      {held && <> <span className={`badge ${a.balance == null ? 'neg' : 'warn'}`}>{held}</span></>}
                      {day && <> <span className="badge">{day}</span></>}
                      {/* Money in the settlement fund rather than invested;
                          amber only for an amount worth acting on
                          (lib/cash.ts). Its share is in the sheet. */}
                      {cash && cash.cash > 0 && (
                        <>
                          {' '}
                          <span className={`badge${cash.flagged ? ' warn' : ''}`}>
                            <Masked>{fmt(cash.cash, a.currency)}</Masked>
                            {cash.flagged ? ' uninvested' : ' in cash'}
                          </span>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="list-row-value">
                    <Masked>{a.held && a.balance == null ? '--' : fmt(signedBalance(a), a.currency)}</Masked>
                  </span>
                  {CHEVRON}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Positions a payload cached before they named their account
          can't go in an account's sheet, so they stay here. */}
      {looseHoldings.length > 0 && (
        <>
          <button
            className="holdings-toggle"
            onClick={() => toggleHoldings(inst.item_id)}
            aria-expanded={expandedHoldings.has(inst.item_id)}
          >
            <span className="holdings-title">
              Holdings
              <span className="holdings-count">{looseHoldings.length}</span>
            </span>
            <span className="holdings-summary">
              <Masked>{fmt(looseHoldings.reduce((sum, h) => sum + (h.value ?? 0), 0), instCurrency)}</Masked>
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
          {expandedHoldings.has(inst.item_id) && <HoldingsTable holdings={looseHoldings} flagged={instCash.flaggedAccounts} />}
        </>
      )}
    </section>
  );
}
